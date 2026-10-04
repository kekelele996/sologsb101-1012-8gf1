/**
 * 送检 / 出车台账 slice：运维班「送检登记」与计量站「出车批次」两侧分账。
 *
 * 核心约束：
 * - 运维班按台站记仪器安装位置与送检登记；计量站按出车批次记出车日期、名额与逐台结论；
 * - 两边按台站码 + 序列号对账，对不上先挂「对账失败」等确认，不写结论；
 * - 批次名额满了后面的登记排队等下一趟；已出车批次照旧不动；
 * - 计量站退回某台只退这一台，其余照旧入库；对账失败后按运维班这侧重试；
 * - 旧数据没有出车批次，由 db v3 升级迁移按标定日期 + 机构切批挂回。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import type { Dispatch as DispatchRecord, DispatchFilterState, DispatchState } from '@/types/dispatch';
import { createEmptyDispatchFilter } from '@/types/dispatch';
import type { BatchDraft, BatchFilterState, BatchItemVerdict, CalibBatch } from '@/types/batch';
import { createEmptyBatchFilter, freeSeats, occupiedSeats } from '@/types/batch';
import { judgeCalibration } from '@/types/calibration';
import type { Calibration } from '@/types/calibration';
import type { RootState } from '@/stores/store';
import { reconcileOne } from '@/utils/reconcile';

type WithLedger = RootState;

/** 仍在送检流程中的状态（同一仪器不允许重复登记送检） */
const ACTIVE_DISPATCH_STATES: DispatchState[] = ['排队中', '已排入', '已出车', '对账失败'];

export interface LedgerSliceState {
  dispatches: DispatchRecord[];
  batches: CalibBatch[];
  ready: boolean;
  error: string | null;
  dispatchFilter: DispatchFilterState;
  batchFilter: BatchFilterState;
  lastReceipt: string;
}

const initialState: LedgerSliceState = {
  dispatches: [],
  batches: [],
  ready: false,
  error: null,
  dispatchFilter: createEmptyDispatchFilter(),
  batchFilter: createEmptyBatchFilter(),
  lastReceipt: '',
};

/* ------------------------------ 运维班：送检登记 ------------------------------ */

/**
 * 登记送检：自动排入「最早一趟还剩名额的待出车批次」；
 * 名额全满则排队等下一趟（已出车批次不补排）。
 */
export const createDispatch = createAsyncThunk(
  'ledger/createDispatch',
  async (
    payload: {
      instrumentId: string;
      stationId: string;
      sendDate: string;
      operator: string;
      remark: string;
    },
    { rejectWithValue }
  ) => {
    const instrument = await db.instruments.get(payload.instrumentId);
    if (!instrument) return rejectWithValue('仪器档案不存在，无法登记送检');
    const station = await db.stations.get(payload.stationId);
    if (!station) return rejectWithValue('台站不存在，无法登记送检');
    if (instrument.stationId !== payload.stationId) {
      return rejectWithValue('仪器当前安装位置与所选台站不符，以运维班安装位置台账为准');
    }
    const duplicate = (await db.dispatches.where('instrumentId').equals(instrument.id).toArray()).find((row) =>
      ACTIVE_DISPATCH_STATES.includes(row.state)
    );
    if (duplicate) {
      return rejectWithValue(`该仪器已有一条「${duplicate.state}」的送检登记，请勿重复送检`);
    }

    const now = Date.now();
    const waitingCount = await db.dispatches.where('state').equals('排队中').count();
    const dispatchRow: DispatchRecord = {
      id: createId('dsp'),
      instrumentId: instrument.id,
      stationId: station.id,
      stationCode: station.code,
      serialNo: instrument.serialNo,
      sendDate: payload.sendDate,
      state: '排队中',
      batchId: '',
      queueOrder: waitingCount,
      mismatchReason: '',
      returnReason: '',
      calibrationId: '',
      operator: payload.operator,
      remark: payload.remark,
      createdAt: now,
      updatedAt: now,
    };

    // 找最早一趟还有名额的待出车批次
    const candidates = (await db.batches.where('state').equals('待出车').toArray())
      .filter((batch) => freeSeats(batch) > 0)
      .sort((a, b) => a.departDate.localeCompare(b.departDate) || a.createdAt - b.createdAt);
    const target = candidates[0];

    await db.transaction('rw', [db.dispatches, db.batches, db.instruments, db.stations], async () => {
      if (target) {
        const seat = occupiedSeats(target);
        dispatchRow.state = '已排入';
        dispatchRow.batchId = target.id;
        dispatchRow.queueOrder = seat;
        const item: BatchItemVerdict = {
          dispatchId: dispatchRow.id,
          instrumentId: instrument.id,
          stationCode: station.code,
          serialNo: instrument.serialNo,
          sensitivity: null,
          selfNoise: null,
          verdict: '待判定',
          returned: false,
          note: '',
          createdAt: now,
          updatedAt: now,
        };
        await db.batches.update(target.id, {
          items: [...target.items, item],
          updatedAt: now,
        } as never);
      }
      await db.dispatches.put(dispatchRow);
    });

    return { dispatch: dispatchRow, queued: !target, batchCode: target?.code ?? '' };
  }
);

/** 仅排队中（从未出车）的登记可删除 */
export const removeDispatch = createAsyncThunk(
  'ledger/removeDispatch',
  async (dispatchId: string, { rejectWithValue }) => {
    const row = await db.dispatches.get(dispatchId);
    if (!row) return rejectWithValue('送检登记不存在');
    if (row.state !== '排队中') {
      return rejectWithValue(`「${row.state}」的登记不能删除，已排入或出车的记录需在批次侧处理`);
    }
    await db.dispatches.delete(dispatchId);
    return dispatchId;
  }
);

/** 撤回：已排入（待出车）/ 对账失败（挂起）→ 回到队尾排队，等下一趟 */
export const withdrawDispatch = createAsyncThunk(
  'ledger/withdrawDispatch',
  async (dispatchId: string, { rejectWithValue }) => {
    const row = await db.dispatches.get(dispatchId);
    if (!row) return rejectWithValue('送检登记不存在');
    if (row.state === '已出车' || row.state === '已入库') {
      return rejectWithValue('已出车/已入库的记录照旧不动，不能撤回');
    }
    const now = Date.now();
    await db.transaction('rw', [db.dispatches, db.batches], async () => {
      if (row.batchId) {
        const batch = await db.batches.get(row.batchId);
        if (batch && batch.state === '待出车') {
          await db.batches.update(batch.id, {
            items: batch.items.filter((item) => item.dispatchId !== dispatchId),
            updatedAt: now,
          } as never);
        }
      }
      const waitingCount = await db.dispatches.where('state').equals('排队中').count();
      await db.dispatches.update(dispatchId, {
        state: '排队中',
        batchId: '',
        queueOrder: waitingCount,
        mismatchReason: '',
        returnReason: '',
        updatedAt: now,
      } as never);
    });
    return dispatchId;
  }
);

/**
 * 以运维班安装位置台账刷新快照后重试对账：
 * 计量站现场记录与运维班不一致挂起后，运维班这侧确认仪器仍在该台站、
 * 序列号以仪器档案为准，刷新台站码/序列号快照再试。
 */
export const retryReconcileDispatch = createAsyncThunk(
  'ledger/retryReconcileDispatch',
  async (payload: { dispatchId: string; refreshFromOps: boolean }, { rejectWithValue }) => {
    const result = await reconcileDispatchById(payload.dispatchId, {
      refreshFromOps: payload.refreshFromOps,
    });
    if ('error' in result) return rejectWithValue(result.error);
    return result;
  }
);

/**
 * 对账核心：以运维班侧为准比对批次逐台记录。
 * - 对不上：挂「对账失败」，批次侧现场记录照旧，不写结论；
 * - 计量站标记退回且身份核对一致：仅这一台置「已退回」，不生成标定；
 * - 身份一致且有结论：生成/更新标定，仪器照旧入库。
 */
async function reconcileDispatchById(
  dispatchId: string,
  options: { refreshFromOps: boolean }
): Promise<
  | { dispatchId: string; state: DispatchState; reason: string; batchCode: string }
  | { error: string }
> {
  const dispatchRow = await db.dispatches.get(dispatchId);
  if (!dispatchRow) return { error: '送检登记不存在' };
  if (!dispatchRow.batchId) return { error: '该登记还在排队，未排入任何出车批次' };
  const batch = await db.batches.get(dispatchRow.batchId);
  if (!batch) return { error: '关联的出车批次不存在' };
  if (batch.state !== '已出车') return { error: '批次尚未出车，出车回来后才能对账' };
  const item = batch.items.find((row) => row.dispatchId === dispatchId);
  if (!item) return { error: '计量站未登记该台，先挂起待确认' };

  const now = Date.now();

  // 以运维班侧为准：仪器仍安装在登记台站，台站码/序列号快照按档案刷新
  if (options.refreshFromOps) {
    const instrument = await db.instruments.get(dispatchRow.instrumentId);
    const station = instrument ? await db.stations.get(instrument.stationId) : undefined;
    if (instrument && station) {
      await db.dispatches.update(dispatchId, {
        stationId: instrument.stationId,
        stationCode: station.code,
        serialNo: instrument.serialNo,
        updatedAt: now,
      } as never);
      dispatchRow.stationId = instrument.stationId;
      dispatchRow.stationCode = station.code;
      dispatchRow.serialNo = instrument.serialNo;
    }
  }

  const instrument = await db.instruments.get(dispatchRow.instrumentId);
  const station = await db.stations.get(dispatchRow.stationId);
  const outcome = reconcileOne(dispatchRow, item, instrument, station);
  if (!outcome.ok) {
    await db.dispatches.update(dispatchId, {
      state: '对账失败',
      mismatchReason: outcome.reason,
      updatedAt: now,
    } as never);
    return { dispatchId, state: '对账失败', reason: outcome.reason, batchCode: batch.code };
  }

  // 身份一致：计量站只退这一台 → 仅这一台已退回，不影响其余台入库
  if (item.returned) {
    await db.dispatches.update(dispatchId, {
      state: '已退回',
      mismatchReason: '',
      returnReason: item.note || '计量站随车退回该台',
      updatedAt: now,
    } as never);
    return { dispatchId, state: '已退回', reason: item.note || '计量站退回', batchCode: batch.code };
  }

  // 计量站尚未给出结论：身份核对无误但先不写结论，保持已出车待结论
  if (item.verdict === '待判定') {
    await db.dispatches.update(dispatchId, {
      state: '已出车',
      mismatchReason: '',
      updatedAt: now,
    } as never);
    return { dispatchId, state: '已出车', reason: '身份一致，等待计量站结论', batchCode: batch.code };
  }
  if (!instrument) return { error: '仪器档案缺失' };

  // 对账一致且逐台结论已录：照旧入库（幂等，重试不重复生成标定）
  let calibrationId = dispatchRow.calibrationId;
  await db.transaction('rw', [db.dispatches, db.calibrations, db.instruments], async () => {
    const payload: Omit<Calibration, 'id' | 'createdAt' | 'updatedAt'> = {
      instrumentId: instrument.id,
      date: batch.departDate,
      sensitivity: item.sensitivity ?? 0,
      selfNoise: item.selfNoise ?? 0,
      responseVerdict: item.verdict,
      operator: batch.agency,
      agency: batch.agency,
      remark: `${batch.code} 出车标定：${item.note}`.trim(),
    };
    if (calibrationId) {
      const existing = await db.calibrations.get(calibrationId);
      if (existing) {
        await db.calibrations.update(calibrationId, { ...payload, updatedAt: now } as never);
      } else {
        calibrationId = '';
      }
    }
    if (!calibrationId) {
      const created: Calibration = { ...payload, id: createId('cal'), createdAt: now, updatedAt: now };
      await db.calibrations.put(created);
      calibrationId = created.id;
    }
    await db.instruments.update(instrument.id, {
      state: item.verdict === '不合格' ? '待标定' : '在用',
      updatedAt: now,
    } as never);
    await db.dispatches.update(dispatchId, {
      state: '已入库',
      mismatchReason: '',
      calibrationId,
      updatedAt: now,
    } as never);
  });

  return { dispatchId, state: '已入库', reason: item.verdict, batchCode: batch.code };
}

/** 整批对账：逐台核对已出车批次，逐台落状态，互不影响 */
export const reconcileBatch = createAsyncThunk(
  'ledger/reconcileBatch',
  async (batchId: string, { rejectWithValue }) => {
    const batch = await db.batches.get(batchId);
    if (!batch) return rejectWithValue('出车批次不存在');
    if (batch.state !== '已出车') return rejectWithValue('批次尚未出车，不能对账');
    const targets = (await db.dispatches.where('batchId').equals(batchId).toArray()).filter((row) =>
      ['已出车', '对账失败'].includes(row.state)
    );
    const summary = { 入库: 0, 退回: 0, 待结论: 0, 挂起: 0 };
    for (const row of targets) {
      const result = await reconcileDispatchById(row.id, { refreshFromOps: false });
      if ('error' in result) {
        summary.挂起 += 1;
        continue;
      }
      if (result.state === '已入库') summary.入库 += 1;
      else if (result.state === '已退回') summary.退回 += 1;
      else if (result.state === '已出车') summary.待结论 += 1;
      else summary.挂起 += 1;
    }
    return { batchId, ...summary };
  }
);

/* ------------------------------ 计量站：出车批次 ------------------------------ */

export const createBatch = createAsyncThunk(
  'ledger/createBatch',
  async (payload: BatchDraft, { rejectWithValue }) => {
    const code = payload.code.trim();
    if (!code) return rejectWithValue('请填写批次号');
    if (!Number.isFinite(payload.capacity) || payload.capacity < 1) {
      return rejectWithValue('能带台数至少为 1');
    }
    const duplicated = await db.batches.where('code').equals(code).first();
    if (duplicated) return rejectWithValue(`批次号「${code}」已存在`);
    const now = Date.now();
    const row: CalibBatch = {
      id: createId('bt'),
      code,
      departDate: payload.departDate,
      capacity: Math.floor(payload.capacity),
      agency: payload.agency.trim(),
      state: '待出车',
      items: [],
      remark: payload.remark.trim(),
      createdAt: now,
      updatedAt: now,
    };
    await db.batches.put(row);
    return row;
  }
);

/** 编辑批次：仅待出车批次可改；名额不能调到小于已占用台数 */
export const updateBatch = createAsyncThunk(
  'ledger/updateBatch',
  async (payload: { id: string; patch: Partial<BatchDraft> }, { rejectWithValue }) => {
    const batch = await db.batches.get(payload.id);
    if (!batch) return rejectWithValue('出车批次不存在');
    if (batch.state === '已出车') return rejectWithValue('已出车批次照旧不动，不能修改');
    if (payload.patch.code) {
      const code = payload.patch.code.trim();
      const duplicated = await db.batches.where('code').equals(code).first();
      if (duplicated && duplicated.id !== payload.id) {
        return rejectWithValue(`批次号「${code}」已存在`);
      }
    }
    if (payload.patch.capacity !== undefined && payload.patch.capacity < occupiedSeats(batch)) {
      return rejectWithValue(`名额不能少于已排入的 ${occupiedSeats(batch)} 台`);
    }
    await db.batches.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
    return payload;
  }
);

/** 删除批次：仅待出车批次；排入的登记全部退回排队 */
export const removeBatch = createAsyncThunk(
  'ledger/removeBatch',
  async (batchId: string, { rejectWithValue }) => {
    const batch = await db.batches.get(batchId);
    if (!batch) return rejectWithValue('出车批次不存在');
    if (batch.state === '已出车') return rejectWithValue('已出车批次照旧不动，不能删除');
    const now = Date.now();
    await db.transaction('rw', [db.batches, db.dispatches], async () => {
      const linked = await db.dispatches.where('batchId').equals(batchId).toArray();
      let waiting = await db.dispatches.where('state').equals('排队中').count();
      for (const row of linked) {
        await db.dispatches.update(row.id, {
          state: '排队中',
          batchId: '',
          queueOrder: waiting,
          mismatchReason: '',
          returnReason: '',
          updatedAt: now,
        } as never);
        waiting += 1;
      }
      await db.batches.delete(batchId);
    });
    return batchId;
  }
);

/** 批次出车：已排入 → 已出车；排队中的不随车，已出车后不补排 */
export const departBatch = createAsyncThunk(
  'ledger/departBatch',
  async (batchId: string, { rejectWithValue }) => {
    const batch = await db.batches.get(batchId);
    if (!batch) return rejectWithValue('出车批次不存在');
    if (batch.state !== '待出车') return rejectWithValue('该批次已经出车');
    const now = Date.now();
    await db.transaction('rw', [db.batches, db.dispatches], async () => {
      await db.batches.update(batchId, { state: '已出车', updatedAt: now } as never);
      const linked = await db.dispatches.where('batchId').equals(batchId).toArray();
      for (const row of linked) {
        if (row.state === '已排入') {
          await db.dispatches.update(row.id, { state: '已出车', updatedAt: now } as never);
        }
      }
    });
    return batchId;
  }
);

/** 计量站录逐台结论：仅已出车批次、未退回、且对账不挂起的台可写 */
export const setBatchItemVerdict = createAsyncThunk(
  'ledger/setBatchItemVerdict',
  async (
    payload: {
      batchId: string;
      dispatchId: string;
      sensitivity: number;
      selfNoise: number;
      verdict: BatchItemVerdict['verdict'];
      note: string;
    },
    { rejectWithValue }
  ) => {
    const batch = await db.batches.get(payload.batchId);
    if (!batch) return rejectWithValue('出车批次不存在');
    if (batch.state !== '已出车') return rejectWithValue('批次出车回来后才能登记逐台结论');
    const dispatchRow = await db.dispatches.get(payload.dispatchId);
    if (!dispatchRow) return rejectWithValue('对应的送检登记不存在');
    if (dispatchRow.state === '对账失败') {
      return rejectWithValue('该台对账未确认，先挂起，暂不写结论');
    }
    if (dispatchRow.state === '已入库' || dispatchRow.state === '已退回') {
      return rejectWithValue('该台已入库/已退回，记录照旧不动');
    }
    const item = batch.items.find((row) => row.dispatchId === payload.dispatchId);
    if (!item) return rejectWithValue('该台不在本批次台账中');
    if (item.returned) return rejectWithValue('该台已退回，不能登记结论');
    const instrument = await db.instruments.get(item.instrumentId);
    const auto = judgeCalibration(
      instrument?.type ?? '宽频带',
      payload.sensitivity,
      payload.selfNoise
    );
    const now = Date.now();
    await db.batches.update(payload.batchId, {
      items: batch.items.map((row) =>
        row.dispatchId === payload.dispatchId
          ? {
              ...row,
              sensitivity: payload.sensitivity,
              selfNoise: payload.selfNoise,
              verdict: payload.verdict === '待判定' ? auto : payload.verdict,
              note: payload.note,
              updatedAt: now,
            }
          : row
      ),
      updatedAt: now,
    } as never);
    return { batchId: payload.batchId, dispatchId: payload.dispatchId, autoVerdict: auto };
  }
);

/** 计量站修正现场登记的台站码/序列号（对账挂起时由计量站先核对更正，不自动写结论） */
export const correctItemIdentity = createAsyncThunk(
  'ledger/correctItemIdentity',
  async (
    payload: { batchId: string; dispatchId: string; stationCode: string; serialNo: string },
    { rejectWithValue }
  ) => {
    const batch = await db.batches.get(payload.batchId);
    if (!batch) return rejectWithValue('出车批次不存在');
    if (batch.state !== '已出车') return rejectWithValue('仅已出车批次需要核对现场记录');
    const dispatchRow = await db.dispatches.get(payload.dispatchId);
    if (!dispatchRow) return rejectWithValue('对应的送检登记不存在');
    if (dispatchRow.state !== '对账失败' && dispatchRow.state !== '已出车') {
      return rejectWithValue('该台状态不允许修改现场记录');
    }
    const now = Date.now();
    await db.batches.update(payload.batchId, {
      items: batch.items.map((row) =>
        row.dispatchId === payload.dispatchId
          ? {
              ...row,
              stationCode: payload.stationCode.trim(),
              serialNo: payload.serialNo.trim(),
              updatedAt: now,
            }
          : row
      ),
      updatedAt: now,
    } as never);
    return payload;
  }
);

/** 计量站退回某台：只退这一台，其余台照旧；退回不代替对账，身份仍存疑时继续挂起 */
export const returnBatchItem = createAsyncThunk(
  'ledger/returnBatchItem',
  async (payload: { batchId: string; dispatchId: string; note: string }, { rejectWithValue }) => {
    const batch = await db.batches.get(payload.batchId);
    if (!batch) return rejectWithValue('出车批次不存在');
    if (batch.state !== '已出车') return rejectWithValue('批次出车后才能退回仪器');
    const item = batch.items.find((row) => row.dispatchId === payload.dispatchId);
    if (!item) return rejectWithValue('该台不在本批次台账中');
    if (item.returned) return rejectWithValue('该台已退回，只退一次');
    const now = Date.now();
    await db.batches.update(payload.batchId, {
      items: batch.items.map((row) =>
        row.dispatchId === payload.dispatchId
          ? {
              ...row,
              returned: true,
              sensitivity: null,
              selfNoise: null,
              verdict: '待判定',
              note: payload.note || '计量站随车退回',
              updatedAt: now,
            }
          : row
      ),
      updatedAt: now,
    } as never);
    // 身份当前一致：仅这一台落「已退回」，其余台不受影响；对不上则继续挂起等确认
    const result = await reconcileDispatchById(payload.dispatchId, { refreshFromOps: false });
    if ('error' in result) return { batchId: payload.batchId, dispatchId: payload.dispatchId, state: '已出车' as const };
    return result;
  }
);

/** 排队补排：把队首登记依次补入各待出车批次剩余名额（已出车批次不动） */
export const promoteQueue = createAsyncThunk('ledger/promoteQueue', async (_unused, { rejectWithValue }) => {
  const waitingNow = async (): Promise<DispatchRecord[]> =>
    (await db.dispatches.where('state').equals('排队中').toArray()).sort(
      (a, b) => a.sendDate.localeCompare(b.sendDate) || a.queueOrder - b.queueOrder || a.createdAt - b.createdAt
    );
  if ((await waitingNow()).length === 0) {
    return rejectWithValue('队列为空，没有待排入的登记');
  }
  const now = Date.now();
  let moved = 0;
  await db.transaction(
    'rw',
    [db.batches, db.dispatches, db.instruments, db.stations],
    async () => {
    for (;;) {
      const [head] = await waitingNow();
      if (!head) break;
      // 每轮重新读取批次，避免在事务内修改已读快照导致索引数据失效
      const target = (await db.batches.where('state').equals('待出车').toArray())
        .filter((batch) => freeSeats(batch) > 0)
        .sort((a, b) => a.departDate.localeCompare(b.departDate) || a.createdAt - b.createdAt)[0];
      if (!target) break;
      const instrument = await db.instruments.get(head.instrumentId);
      const station = await db.stations.get(head.stationId);
      if (!instrument || !station) break;
      const seat = occupiedSeats(target);
      const item: BatchItemVerdict = {
        dispatchId: head.id,
        instrumentId: instrument.id,
        stationCode: station.code,
        serialNo: instrument.serialNo,
        sensitivity: null,
        selfNoise: null,
        verdict: '待判定',
        returned: false,
        note: '',
        createdAt: now,
        updatedAt: now,
      };
      await db.batches.update(target.id, { items: [...target.items, item], updatedAt: now } as never);
      await db.dispatches.update(head.id, {
        state: '已排入',
        batchId: target.id,
        queueOrder: seat,
        mismatchReason: '',
        updatedAt: now,
      } as never);
      moved += 1;
    }
  });
  return { moved };
});

/* ------------------------------ slice & 订阅 ------------------------------ */

const ledgerSlice = createSlice({
  name: 'ledger',
  initialState,
  reducers: {
    setDispatches(state, action: PayloadAction<DispatchRecord[]>) {
      state.dispatches = action.payload;
      state.ready = true;
      state.error = null;
    },
    setBatches(state, action: PayloadAction<CalibBatch[]>) {
      state.batches = action.payload;
    },
    patchDispatchFilter(state, action: PayloadAction<Partial<DispatchFilterState>>) {
      state.dispatchFilter = { ...state.dispatchFilter, ...action.payload };
    },
    resetDispatchFilter(state) {
      state.dispatchFilter = createEmptyDispatchFilter();
    },
    patchBatchFilter(state, action: PayloadAction<Partial<BatchFilterState>>) {
      state.batchFilter = { ...state.batchFilter, ...action.payload };
    },
    resetBatchFilter(state) {
      state.batchFilter = createEmptyBatchFilter();
    },
    setLedgerReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
    setLedgerError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createDispatch.fulfilled, (state, action) => {
        state.lastReceipt = action.payload.queued
          ? '当前待出车批次名额已满，已排队等下一趟'
          : `已排入批次 ${action.payload.batchCode}，出车前可撤回`;
        state.error = null;
      })
      .addCase(createDispatch.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '送检登记失败';
      })
      .addCase(retryReconcileDispatch.fulfilled, (state, action) => {
        const map: Record<string, string> = {
          已入库: `对账一致，仪器照旧入库，结论「${action.payload.reason}」`,
          已退回: '该台仅作退回处理，其余仪器照旧入库',
          已出车: '台站码与序列号已对上，等计量站补结论后入库',
          对账失败: `仍对不上（${action.payload.reason}），继续挂起待确认`,
        };
        state.lastReceipt = map[action.payload.state] ?? '对账完成';
      })
      .addCase(reconcileBatch.fulfilled, (state, action) => {
        state.lastReceipt = `批次对账完成：入库 ${action.payload.入库} 台、退回 ${action.payload.退回} 台、待结论 ${action.payload.待结论} 台、挂起 ${action.payload.挂起} 台`;
      })
      .addCase(promoteQueue.fulfilled, (state, action) => {
        state.lastReceipt = `已按排队顺序补排 ${action.payload.moved} 台`;
      });
  },
});

export const {
  setDispatches,
  setBatches,
  patchDispatchFilter,
  resetDispatchFilter,
  patchBatchFilter,
  resetBatchFilter,
  setLedgerReceipt,
  setLedgerError,
} = ledgerSlice.actions;

let started = false;

/** 启动送检登记 / 出车批次表实时订阅（幂等） */
export function startLedgerSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<DispatchRecord>(() => db.dispatches).subscribe((rows) => {
    dispatch(setDispatches(rows));
  });
  watchTable<CalibBatch>(() => db.batches).subscribe((rows) => {
    dispatch(setBatches(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectDispatches = (state: WithLedger): DispatchRecord[] => state.ledger.dispatches;
export const selectBatches = (state: WithLedger): CalibBatch[] => state.ledger.batches;
export const selectLedgerReady = (state: WithLedger): boolean => state.ledger.ready;
export const selectDispatchFilter = (state: WithLedger): DispatchFilterState => state.ledger.dispatchFilter;
export const selectBatchFilter = (state: WithLedger): BatchFilterState => state.ledger.batchFilter;

export const selectBatchById = (state: WithLedger, id: string | null | undefined): CalibBatch | null =>
  id ? state.ledger.batches.find((row) => row.id === id) ?? null : null;

/** 排队中的送检登记（按登记先后） */
export const selectWaitingDispatches = (state: WithLedger): DispatchRecord[] =>
  state.ledger.dispatches
    .filter((row) => row.state === '排队中')
    .sort((a, b) => a.sendDate.localeCompare(b.sendDate) || a.queueOrder - b.queueOrder || a.createdAt - b.createdAt);

export default ledgerSlice.reducer;
