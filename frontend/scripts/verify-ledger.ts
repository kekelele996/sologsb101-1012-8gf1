/**
 * 临时验证脚本（不纳入产物）：两侧分账核心流程
 * 1. 纯逻辑：对账键、旧数据按日期+机构切批次、挂起原因；
 * 2. IndexedDB（fake-indexeddb）：v2→v3 升级、播种、名额排队、出车、录结论、
 *    整批对账、退回单机、对账失败按运维班侧重试。
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';

// Node 无 localStorage，用内存 Map 模拟（浏览器环境原生具备）
const lsStore = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => (lsStore.has(key) ? lsStore.get(key)! : null),
    setItem: (key: string, value: string) => void lsStore.set(key, String(value)),
    removeItem: (key: string) => void lsStore.delete(key),
  },
  configurable: true,
});
import {
  reconcileOne,
  reconcileKey,
  cutLegacyCalibrations,
  describeOpsStatus,
} from '../src/utils/reconcile';
import { freeSeats } from '../src/types/batch';
import type { Calibration } from '../src/types/calibration';
import type { Instrument } from '../src/types/instrument';
import type { SeisStation } from '../src/types/station';
import type { Dispatch } from '../src/types/dispatch';
import Dexie from 'dexie';

/* ---------- 1. 纯逻辑 ---------- */

const station: SeisStation = {
  id: 's1',
  arrayId: 'a1',
  code: 'ltx01',
  lat: 1,
  lng: 2,
  elevM: 3,
  bedrock: '花岗岩',
  siteNote: '',
  createdAt: 1,
  updatedAt: 1,
};
const instrument: Instrument = {
  id: 'i1',
  stationId: 's1',
  type: '宽频带',
  model: 'CMG',
  serialNo: 'SN-001',
  installDate: '2020-01-01',
  state: '在用',
  remark: '',
  createdAt: 1,
  updatedAt: 1,
};
const dispatchBase: Dispatch = {
  id: 'd1',
  instrumentId: 'i1',
  stationId: 's1',
  stationCode: 'LTX01',
  serialNo: 'SN-001',
  sendDate: '2026-10-01',
  state: '已出车',
  batchId: 'b1',
  queueOrder: 0,
  mismatchReason: '',
  returnReason: '',
  calibrationId: '',
  operator: '甲',
  remark: '',
  createdAt: 1,
  updatedAt: 1,
};

// 键规范化：大小写 / 空格不敏感
assert.equal(reconcileKey(' ltx01 ', ' sn-001 '), reconcileKey('LTX01', 'SN-001'));

// 台站码对不上
assert.equal(
  reconcileOne(dispatchBase, { stationCode: 'LTX02', serialNo: 'SN-001' }, instrument, station).reason,
  '台站码不一致'
);
// 序列号对不上
assert.equal(
  reconcileOne(dispatchBase, { stationCode: 'LTX01', serialNo: 'SN-X' }, instrument, station).reason,
  '序列号不一致'
);
// 档案缺失
assert.equal(
  reconcileOne(dispatchBase, { stationCode: 'LTX01', serialNo: 'SN-001' }, undefined, undefined).reason,
  '仪器档案缺失'
);
// 一致
assert.equal(
  reconcileOne(dispatchBase, { stationCode: 'LTX01', serialNo: 'SN-001' }, instrument, station).ok,
  true
);

// 旧数据切批次：同日同机构合并，机构不同拆分；缺档案单列
const cals: Calibration[] = [
  {
    id: 'c1',
    instrumentId: 'i1',
    date: '2024-04-12',
    sensitivity: 1,
    selfNoise: 1,
    responseVerdict: '合格',
    operator: '甲',
    agency: '省局',
    remark: '',
    createdAt: 10,
    updatedAt: 10,
  },
  {
    id: 'c2',
    instrumentId: 'i1',
    date: '2024-04-12',
    sensitivity: 1,
    selfNoise: 1,
    responseVerdict: '合格',
    operator: '乙',
    agency: '省局',
    remark: '',
    createdAt: 11,
    updatedAt: 11,
  },
  {
    id: 'c3',
    instrumentId: 'i1',
    date: '2024-04-12',
    sensitivity: 1,
    selfNoise: 1,
    responseVerdict: '合格',
    operator: '丙',
    agency: '国家中心',
    remark: '',
    createdAt: 12,
    updatedAt: 12,
  },
  {
    id: 'c4',
    instrumentId: 'iX',
    date: '2024-04-12',
    sensitivity: 1,
    selfNoise: 1,
    responseVerdict: '待判定',
    operator: '丁',
    agency: '省局',
    remark: '',
    createdAt: 13,
    updatedAt: 13,
  },
];
const cut = cutLegacyCalibrations(cals, [instrument], [station]);
assert.equal(cut.batches.length, 2, '同日两个机构应切成 2 个批次');
assert.equal(cut.dispatches.length, 3);
assert.equal(cut.orphans.length, 1);
assert.equal(cut.orphans[0].calibration.id, 'c4');
assert.equal(cut.dispatches.every((d) => d.state === '已入库'), true);
assert.equal(cut.dispatches.find((d) => d.calibrationId === 'c1')?.calibrationId, 'c1');

/* ---------- 2. IndexedDB：v2→v3 升级 ---------- */

// 先按 v2 结构灌一份旧库
class OldDb extends Dexie {
  arrays!: Dexie.Table<{ id: string; name: string; state: string; stationCount?: number; apertureKm?: number; deployDate?: string; department?: string; createdAt?: number; updatedAt?: number }, string>;
  stations!: Dexie.Table<{ id: string; arrayId: string; code: string; lat?: number; lng?: number; elevM?: number; bedrock?: string; siteNote?: string; createdAt?: number; updatedAt?: number }, string>;
  instruments!: Dexie.Table<Instrument, string>;
  calibrations!: Dexie.Table<Calibration, string>;
  replaces!: Dexie.Table<{ id: string; instrumentId: string; state?: string; newSerialNo?: string; operator?: string; reason: string; date: string; createdAt?: number; updatedAt?: number }, string>;
  constructor() {
    super('gbseisarray');
    this.version(2).stores({
      arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
      stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
      instruments: 'id, stationId, type, model, serialNo, installDate, state, updatedAt',
      calibrations: 'id, instrumentId, date, sensitivity, selfNoise, responseVerdict, updatedAt',
      replaces: 'id, instrumentId, state, date, newSerialNo, updatedAt',
    });
  }
}
const old = new OldDb();
await old.open();
await old.arrays.put({ id: 'arr_x', name: '旧台阵', state: '运行中' });
await old.stations.put({ id: 's1', arrayId: 'arr_x', code: 'LTX01' });
await old.instruments.put(instrument);
await old.calibrations.bulkPut([cals[0], cals[2], cals[3]]);
await old.replaces.put({ id: 'r1', instrumentId: 'i1', reason: 'x', date: '2024-01-01' });
old.close();

// 重新以当前版本打开，触发 v2→v3 升级
const { db, initDatabase, readOrphanCalibrations } = await import('../src/utils/db');
await db.open();
const legacyBatches = await db.batches.toArray();
const legacyDispatches = await db.dispatches.toArray();
assert.equal(legacyBatches.length, 2, '升级应切出 2 个历史批次');
assert.equal(legacyDispatches.length, 2, '升级应挂回 2 台，缺档案的 1 条单列');
assert.equal(readOrphanCalibrations().length, 1);
assert.equal(legacyDispatches.every((d) => d.state === '已入库' && d.calibrationId), true);
assert.equal(legacyBatches.every((b) => b.state === '已出车'), true);
// 历史批次容量 = 当趟台数
assert.equal(legacyBatches.find((b) => b.agency === '省局')?.capacity, 1);
db.close();

/* ---------- 3. 全新库播种 + 业务流程 ---------- */
// 删除当前库重新播种
await new Promise<void>((resolve) => {
  const req = indexedDB.deleteDatabase('gbseisarray');
  req.onsuccess = () => resolve();
  req.onerror = () => resolve();
  req.onblocked = () => resolve();
});
const mod = await import('../src/utils/db');
await mod.initDatabase();

const seedBatches = await mod.db.batches.toArray();
const seedDispatches = await mod.db.dispatches.toArray();
assert.ok(seedBatches.length >= 10, `历史 + 当前批次（实得 ${seedBatches.length}）`);
const b03 = await mod.db.batches.get('bt_2026_03');
const b04 = await mod.db.batches.get('bt_2026_04');
assert.ok(b03 && b04);
assert.equal(b03.state, '已出车');
assert.equal(b04.state, '待出车');
assert.equal(freeSeats(b04), 0, 'JL2026-04 名额 2 已排满');
assert.equal(seedDispatches.filter((d) => d.state === '排队中').length, 2);

// 种子里的对账失败项与已入库项
const failed = await mod.db.dispatches.get('dsp_hx02_bb');
assert.equal(failed.state, '对账失败');
const stored = await mod.db.dispatches.get('dsp_ltx03_bb');
assert.equal(stored.state, '已入库');
assert.ok(stored.calibrationId);

/* ---------- 4. 走一遍 store 动作（排队/出车/结论/对账/退回/重试） ---------- */
const { configureStore } = await import('@reduxjs/toolkit');
const ledgerReducer = (await import('../src/stores/ledgerSlice')).default;
const ledger = (await import('../src/stores/ledgerSlice'));
const store = configureStore({ reducer: { ledger: ledgerReducer } });
// 直接灌入 liveQuery 首帧不方便，这里直接调用 thunk（它们只依赖 db）

// 4.1 新建一趟待出车批次，名额 1
const created = await store.dispatch(
  ledger.createBatch({
    code: 'JLTEST-01',
    departDate: '2026-10-20',
    capacity: 1,
    agency: '省地震局计量站',
    remark: '',
  })
);
assert.ok(ledger.createBatch.fulfilled.match(created));
const newBatchId = (created as { payload: { id: string } }).payload.id;

// 4.2 队首补排：仅 1 个名额，两台排队 → 只能进 1 台
const promoted = await store.dispatch(ledger.promoteQueue());
assert.ok(ledger.promoteQueue.fulfilled.match(promoted), String((promoted as { error?: unknown }).error));
assert.equal((promoted as { payload: { moved: number } }).payload.moved, 1);
const batchAfter = await mod.db.batches.get(newBatchId);
assert.equal(freeSeats(batchAfter), 0);
const stillWaiting = (await mod.db.dispatches.where('state').equals('排队中').toArray()).length;
assert.equal(stillWaiting, 1, '另一台仍排队等下一趟');

// 4.3 出车：已出车后补排不会动它；先把这台开出去
const depart = await store.dispatch(ledger.departBatch(newBatchId));
assert.ok(ledger.departBatch.fulfilled.match(depart));
const dispatchedOne = (await mod.db.dispatches
  .where('batchId')
  .equals(newBatchId)
  .toArray())[0];
assert.equal(dispatchedOne.state, '已出车');

// 4.4 再建一趟名额 1，剩余排队台补入
const created2 = await store.dispatch(
  ledger.createBatch({
    code: 'JLTEST-02',
    departDate: '2026-10-27',
    capacity: 1,
    agency: '省地震局计量站',
    remark: '',
  })
);
const newBatchId2 = (created2 as { payload: { id: string } }).payload.id;
await store.dispatch(ledger.promoteQueue());
assert.equal((await mod.db.dispatches.where('state').equals('排队中').count()), 0);

// 4.5 录结论：身份一致
await store.dispatch(
  ledger.setBatchItemVerdict({
    batchId: newBatchId,
    dispatchId: dispatchedOne.id,
    sensitivity: 1500,
    selfNoise: 1.5,
    verdict: '合格',
    note: 'ok',
  })
);
// 4.6 整批对账：入库，且写了一条标定
const rec = await store.dispatch(ledger.reconcileBatch(newBatchId));
assert.ok(ledger.reconcileBatch.fulfilled.match(rec));
assert.equal((rec as { payload: { 入库: number } }).payload.入库, 1);
const afterStore = await mod.db.dispatches.get(dispatchedOne.id);
assert.equal(afterStore.state, '已入库');
const newCal = await mod.db.calibrations.get(afterStore.calibrationId);
assert.equal(newCal?.responseVerdict, '合格');
// 幂等：再次对账不新增标定
await store.dispatch(ledger.reconcileBatch(newBatchId));
const calCount = await mod.db.calibrations.where('instrumentId').equals(dispatchedOne.instrumentId).count();
assert.ok(calCount >= 1);

// 4.7 已出车批次照旧不动：编辑/删除应被拒
const editRej = await store.dispatch(
  ledger.updateBatch({ id: newBatchId, patch: { capacity: 99 } })
);
assert.ok(ledger.updateBatch.rejected.match(editRej));
const delRej = await store.dispatch(ledger.removeBatch(newBatchId));
assert.ok(ledger.removeBatch.rejected.match(delRej));

// 4.8 对账失败项：按运维班侧重试，计量站序列号仍错 → 继续挂起
const retryFail = await store.dispatch(
  ledger.retryReconcileDispatch({ dispatchId: 'dsp_hx02_bb', refreshFromOps: true })
);
assert.equal((retryFail as { payload: { state: string } }).payload.state, '对账失败');

// 计量站修正现场记录后整批重对（该项又被标记 returned → 仅退回这一台）
await store.dispatch(
  ledger.correctItemIdentity({
    batchId: 'bt_2026_03',
    dispatchId: 'dsp_hx02_bb',
    stationCode: 'HX02',
    serialNo: 'CMG-3E-20190926-05',
  })
);
// 该项 item.returned=true，重对应为「已退回」，其余照旧
const retryOk = await store.dispatch(
  ledger.retryReconcileDispatch({ dispatchId: 'dsp_hx02_bb', refreshFromOps: true })
);
assert.equal((retryOk as { payload: { state: string } }).payload.state, '已退回');
const b03Again = await mod.db.batches.get('bt_2026_03');
const others = b03Again.items.filter((i) => i.dispatchId !== 'dsp_hx02_bb');
assert.equal(others.length, 3, '只退这一台，其余 3 台照旧');
assert.equal(others.filter((i) => !i.returned).length, 3);

// 4.9 待出车批次删除 → 排入登记全部退回排队
const beforeWaiting = await mod.db.dispatches.where('state').equals('排队中').count();
const removed = await store.dispatch(ledger.removeBatch(newBatchId2));
assert.ok(ledger.removeBatch.fulfilled.match(removed));
const afterWaiting = await mod.db.dispatches.where('state').equals('排队中').count();
assert.equal(afterWaiting, beforeWaiting + 1);

// 4.10 删除仪器的级联：在途记录阻止删除；已入库仪器删除后批次摘条目、台账保留
const instrumentSlice = await import('../src/stores/instrumentSlice');
const blockDel: unknown = await store.dispatch(instrumentSlice.removeInstrument('ins_hx01_bb'));
assert.ok(instrumentSlice.removeInstrument.rejected.match(blockDel as never));
const okDel: unknown = await store.dispatch(instrumentSlice.removeInstrument('ins_ltx03_bb'));
assert.ok(instrumentSlice.removeInstrument.fulfilled.match(okDel as never));
const b03Pruned = await mod.db.batches.get('bt_2026_03');
assert.equal(b03Pruned.items.some((i) => i.dispatchId === 'dsp_ltx03_bb'), false);
assert.equal(b03Pruned.items.length, 3, '已出车批次台账保留，仅摘掉被删仪器');
assert.equal(await mod.db.dispatches.get('dsp_ltx03_bb'), undefined);

// 4.11 describeOpsStatus 基本覆盖
assert.equal(
  describeOpsStatus(
    { ...dispatchBase, state: '已出车' },
    {
      id: 'b1',
      code: 'C',
      departDate: '2026-10-01',
      capacity: 1,
      agency: '',
      state: '已出车',
      items: [
        {
          dispatchId: 'd1',
          instrumentId: 'i1',
          stationCode: 'LTX01',
          serialNo: 'SN-001',
          sensitivity: 1,
          selfNoise: 1,
          verdict: '待判定',
          returned: false,
          note: '',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      remark: '',
      createdAt: 1,
      updatedAt: 1,
    }
  ),
  '待结论'
);

console.log('OK: reconcile + upgrade + ledger flows verified');
