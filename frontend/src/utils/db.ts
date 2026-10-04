/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbseisarray，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（台阵 → 台站 → 仪器 → 标定 / 更换）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie';
import type { SeisArray } from '@/types/array';
import type { SeisStation } from '@/types/station';
import type { Instrument } from '@/types/instrument';
import { judgeCalibration } from '@/types/calibration';
import type { Calibration } from '@/types/calibration';
import type { Replace } from '@/types/replace';
import type { Dispatch } from '@/types/dispatch';
import type { CalibBatch } from '@/types/batch';
import { cutLegacyCalibrations } from '@/utils/reconcile';

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3;

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbseisarray';

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbseisarray:db-version',
  lastBackupAt: 'gbseisarray:last-backup-at',
  lastArrayId: 'gbseisarray:last-array-id',
  /** v3 升级时切不出来的旧标定（单列等人工确认） */
  orphanCalibrations: 'gbseisarray:v3-orphan-calibrations',
} as const;

/** 备份文件结构，供 utils/export.ts 与几何页使用 */
export interface BackupPayload {
  app: 'gbseisarray';
  dbVersion: number;
  exportedAt: string;
  arrays: SeisArray[];
  stations: SeisStation[];
  instruments: Instrument[];
  calibrations: Calibration[];
  replaces: Replace[];
  dispatches: Dispatch[];
  batches: CalibBatch[];
}

export class SeisArrayDatabase extends Dexie {
  arrays!: Table<SeisArray, string>;
  stations!: Table<SeisStation, string>;
  instruments!: Table<Instrument, string>;
  calibrations!: Table<Calibration, string>;
  replaces!: Table<Replace, string>;
  /** 运维班：送检登记 */
  dispatches!: Table<Dispatch, string>;
  /** 计量站：出车批次（含逐台结论） */
  batches!: Table<CalibBatch, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      arrays: 'id, name, state',
      stations: 'id, arrayId, code',
      instruments: 'id, stationId, serialNo, state',
      calibrations: 'id, instrumentId, date',
      replaces: 'id, instrumentId, state',
    });

    // v2：补齐筛选与统计需要的索引（孔径/布设日期、经纬度/基岩、类型/序列号、灵敏度/结论、原因）
    this.version(2).stores({
      arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
      stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
      instruments: 'id, stationId, type, model, serialNo, installDate, state, updatedAt',
      calibrations: 'id, instrumentId, date, sensitivity, selfNoise, responseVerdict, updatedAt',
      replaces: 'id, instrumentId, state, date, newSerialNo, updatedAt',
    });

    // v3：运维班送检登记 / 计量站出车批次两侧分账
    // 旧标定没有出车批次，按「标定日期 + 机构」切出历史批次挂回台站，切不出来的单列
    this.version(DB_VERSION)
      .stores({
        arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
        stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
        instruments: 'id, stationId, type, model, serialNo, installDate, state, updatedAt',
        calibrations: 'id, instrumentId, date, sensitivity, selfNoise, responseVerdict, updatedAt',
        replaces: 'id, instrumentId, state, date, newSerialNo, updatedAt',
        dispatches:
          'id, instrumentId, stationId, stationCode, serialNo, state, batchId, calibrationId, sendDate, updatedAt',
        batches: 'id, code, state, departDate, agency, updatedAt',
      })
      .upgrade(async (tx) => {
        // v2 → v3：历史数据缺字段时补齐（只补缺，绝不覆盖已有的 agency / 结论等台账值）
        const defaults: Array<[string, () => Record<string, unknown>]> = [
          ['arrays', () => ({ apertureKm: 0, stationCount: 0, department: '' })],
          ['stations', () => ({ lat: 0, lng: 0, elevM: 0, bedrock: '花岗岩', siteNote: '' })],
          ['instruments', () => ({ type: '宽频带', model: '', state: '在用', remark: '' })],
          ['calibrations', () => ({ sensitivity: 0, selfNoise: 0, responseVerdict: '待判定', agency: '' })],
          ['replaces', () => ({ state: '待更换', newSerialNo: '', operator: '' })],
        ];
        for (const [tableName, factory] of defaults) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now();
              if (typeof row.createdAt !== 'number') row.createdAt = now;
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt;
              const filled = factory();
              Object.keys(filled).forEach((key) => {
                if (row[key] === undefined) row[key] = filled[key];
              });
            });
        }

        // 旧标定按标定日期 + 机构切批次挂回台站
        const [calibrations, instruments, stations] = await Promise.all([
          tx.table<Calibration, string>('calibrations').toArray(),
          tx.table<Instrument, string>('instruments').toArray(),
          tx.table<SeisStation, string>('stations').toArray(),
        ]);
        const cut = cutLegacyCalibrations(calibrations, instruments, stations);
        if (cut.batches.length > 0) {
          await tx.table('batches').bulkAdd(cut.batches);
        }
        if (cut.dispatches.length > 0) {
          await tx.table('dispatches').bulkAdd(cut.dispatches);
        }
        // 切不出来的旧标定单列（不丢弃），写 localStorage 供页面提示人工确认
        if (cut.orphans.length > 0) {
          try {
            localStorage.setItem(LS_KEYS.orphanCalibrations, JSON.stringify(cut.orphans));
          } catch {
            // localStorage 不可用时忽略，原始标定记录仍在 calibrations 表中
          }
        }
      });
  }
}

export const db = new SeisArrayDatabase();

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 订阅单表变化（Dexie liveQuery），返回取消订阅函数 */
export function watchTable<T>(
  table: () => Table<T, string>
): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray());
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([]),
      });
      return () => subscription.unsubscribe();
    },
  };
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedCalibration {
  id: string;
  instrumentId: string;
  date: string;
  sensitivity: number;
  selfNoise: number;
  operator: string;
  agency: string;
  remark: string;
}

interface SeedInstrument {
  id: string;
  stationId: string;
  type: Instrument['type'];
  model: string;
  serialNo: string;
  installDate: string;
  state: Instrument['state'];
  remark: string;
  calibrations: SeedCalibration[];
}

interface SeedStation {
  id: string;
  arrayId: string;
  code: string;
  lat: number;
  lng: number;
  elevM: number;
  bedrock: SeisStation['bedrock'];
  siteNote: string;
  instruments: SeedInstrument[];
}

interface SeedArray {
  id: string;
  name: string;
  apertureKm: number;
  deployDate: string;
  state: SeisArray['state'];
  department: string;
  stations: SeedStation[];
}

/**
 * 播种演示数据：2 个台阵 → 5 个台站 → 8 台仪器 → 14 条标定 + 3 条更换，
 * 覆盖「在用 / 待标定 / 已停用」与「合格 / 不合格」以及超期未标定样本。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const daysAgo = (days: number): string => new Date(now - days * 86400000).toISOString().slice(0, 10);

  const arrays: SeedArray[] = [
    {
      id: 'arr_ltx',
      name: '龙门峡流动台阵',
      apertureKm: 24.6,
      deployDate: '2021-04-18',
      state: '运行中',
      department: '省地震局监测中心',
      stations: [
        {
          id: 'stn_ltx_01',
          arrayId: 'arr_ltx',
          code: 'LTX01',
          lat: 30.8421,
          lng: 103.5624,
          elevM: 1180,
          bedrock: '花岗岩',
          siteNote: '基岩出露，噪声本底低',
          instruments: [
            {
              id: 'ins_ltx01_bb',
              stationId: 'stn_ltx_01',
              type: '宽频带',
              model: 'CMG-3ESPC',
              serialNo: 'CMG-3E-20210418-01',
              installDate: '2021-04-18',
              state: '在用',
              remark: '主用宽频带，配 24 位采集器',
              calibrations: [
                {
                  id: 'cal_ltx01_bb_1',
                  instrumentId: 'ins_ltx01_bb',
                  date: '2023-04-20',
                  sensitivity: 1502.4,
                  selfNoise: 1.82,
                  operator: '陈立群',
                  agency: '省地震局计量站',
                  remark: '响应曲线平滑',
                },
                {
                  id: 'cal_ltx01_bb_2',
                  instrumentId: 'ins_ltx01_bb',
                  date: '2024-04-12',
                  sensitivity: 1468.9,
                  selfNoise: 1.95,
                  operator: '陈立群',
                  agency: '省地震局计量站',
                  remark: '灵敏度略降 2.2%，仍在限内',
                },
              ],
            },
            {
              id: 'ins_ltx01_st',
              stationId: 'stn_ltx_01',
              type: '短周期',
              model: 'FSS-3B',
              serialNo: 'FSS3B-20210418-02',
              installDate: '2021-04-18',
              state: '待标定',
              remark: '备份仪器，已逾标定周期',
              calibrations: [
                {
                  id: 'cal_ltx01_st_1',
                  instrumentId: 'ins_ltx01_st',
                  date: '2022-05-06',
                  sensitivity: 412.6,
                  selfNoise: 2.4,
                  operator: '周渝',
                  agency: '省地震局计量站',
                  remark: '首次标定',
                },
              ],
            },
          ],
        },
        {
          id: 'stn_ltx_02',
          arrayId: 'arr_ltx',
          code: 'LTX02',
          lat: 30.9187,
          lng: 103.6412,
          elevM: 1425,
          bedrock: '玄武岩',
          siteNote: '半山台基，交通便利',
          instruments: [
            {
              id: 'ins_ltx02_bb',
              stationId: 'stn_ltx_02',
              type: '宽频带',
              model: 'Trillium-120',
              serialNo: 'T120-20220315-07',
              installDate: '2022-03-15',
              state: '在用',
              remark: '井下安装，深度 42 m',
              calibrations: [
                {
                  id: 'cal_ltx02_bb_1',
                  instrumentId: 'ins_ltx02_bb',
                  date: '2024-03-18',
                  sensitivity: 1204.8,
                  selfNoise: 1.42,
                  operator: '林之遥',
                  agency: '省地震局计量站',
                  remark: '响应一致性良好',
                },
              ],
            },
            {
              id: 'ins_ltx02_st',
              stationId: 'stn_ltx_02',
              type: '短周期',
              model: 'L-4C-3D',
              serialNo: 'L4C-20220315-08',
              installDate: '2022-03-15',
              state: '已停用',
              remark: '2024 年雷击损坏，已提交更换',
              calibrations: [
                {
                  id: 'cal_ltx02_st_1',
                  instrumentId: 'ins_ltx02_st',
                  date: '2023-03-10',
                  sensitivity: 265.2,
                  selfNoise: 4.8,
                  operator: '周渝',
                  agency: '省地震局计量站',
                  remark: '自噪超标，判定不合格',
                },
              ],
            },
          ],
        },
        {
          id: 'stn_ltx_03',
          arrayId: 'arr_ltx',
          code: 'LTX03',
          lat: 30.7802,
          lng: 103.4987,
          elevM: 986,
          bedrock: '石灰岩',
          siteNote: '河谷阶地，需注意汛期供电',
          instruments: [
            {
              id: 'ins_ltx03_bb',
              stationId: 'stn_ltx_03',
              type: '宽频带',
              model: 'STS-2.5',
              serialNo: 'STS25-20230902-11',
              installDate: '2023-09-02',
              state: '在用',
              remark: '新建站首台仪器',
              calibrations: [
                {
                  id: 'cal_ltx03_bb_1',
                  instrumentId: 'ins_ltx03_bb',
                  date: '2024-09-05',
                  sensitivity: 2251.3,
                  selfNoise: 2.05,
                  operator: '林之遥',
                  agency: '省地震局计量站',
                  remark: '脉冲响应合格',
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'arr_hx',
      name: '海西宽频带台阵',
      apertureKm: 46.2,
      deployDate: '2019-09-25',
      state: '运行中',
      department: '国家测震台网中心',
      stations: [
        {
          id: 'stn_hx_01',
          arrayId: 'arr_hx',
          code: 'HX01',
          lat: 25.4321,
          lng: 119.3421,
          elevM: 62,
          bedrock: '花岗岩',
          siteNote: '海岛台，防盐雾处理',
          instruments: [
            {
              id: 'ins_hx01_bb',
              stationId: 'stn_hx_01',
              type: '宽频带',
              model: 'Trillium-Compact',
              serialNo: 'TC-20190925-03',
              installDate: '2019-09-25',
              state: '在用',
              remark: '海岛主用观测设备',
              calibrations: [
                {
                  id: 'cal_hx01_bb_1',
                  instrumentId: 'ins_hx01_bb',
                  date: '2023-09-28',
                  sensitivity: 1498.2,
                  selfNoise: 2.25,
                  operator: '陈立群',
                  agency: '国家测震台网计量中心',
                  remark: '响应合格',
                },
                {
                  id: 'cal_hx01_bb_2',
                  instrumentId: 'ins_hx01_bb',
                  date: '2024-09-30',
                  sensitivity: 1483.6,
                  selfNoise: 2.42,
                  operator: '陈立群',
                  agency: '国家测震台网计量中心',
                  remark: '变化 0.97%，合格',
                },
              ],
            },
            {
              id: 'ins_hx01_sm',
              stationId: 'stn_hx_01',
              type: '强震',
              model: 'ES-T',
              serialNo: 'EST-20190925-04',
              installDate: '2019-09-25',
              state: '在用',
              remark: '结构台阵强震观测',
              calibrations: [
                {
                  id: 'cal_hx01_sm_1',
                  instrumentId: 'ins_hx01_sm',
                  date: '2024-09-30',
                  sensitivity: 1.24,
                  selfNoise: 1.05,
                  operator: '周渝',
                  agency: '国家测震台网计量中心',
                  remark: '强震通道合格',
                },
              ],
            },
          ],
        },
        {
          id: 'stn_hx_02',
          arrayId: 'arr_hx',
          code: 'HX02',
          lat: 25.2894,
          lng: 119.5112,
          elevM: 128,
          bedrock: '砂岩',
          siteNote: '覆盖层较厚，需做场地响应校正',
          instruments: [
            {
              id: 'ins_hx02_bb',
              stationId: 'stn_hx_02',
              type: '宽频带',
              model: 'CMG-3ESPC',
              serialNo: 'CMG-3E-20190926-05',
              installDate: '2019-09-26',
              state: '待标定',
              remark: '夜间自噪抬升，待复标',
              calibrations: [
                {
                  id: 'cal_hx02_bb_1',
                  instrumentId: 'ins_hx02_bb',
                  date: '2023-06-11',
                  sensitivity: 1388.4,
                  selfNoise: 3.9,
                  operator: '林之遥',
                  agency: '国家测震台网计量中心',
                  remark: '自噪接近上限，判定不合格',
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  const replaces: Replace[] = [
    {
      id: 'rpl_ltx02_st',
      instrumentId: 'ins_ltx02_st',
      reason: '雷击导致仪器损坏，标定不合格',
      newSerialNo: 'L4C-20250301-21',
      date: today,
      state: '待更换',
      operator: '周渝',
      remark: '新仪器已到货，待停电窗口安装',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'rpl_hx02_bb',
      instrumentId: 'ins_hx02_bb',
      reason: '自噪持续超标，按台网要求整机更换',
      newSerialNo: 'CMG-3E-20250410-33',
      date: daysAgo(20),
      state: '已更换',
      operator: '林之遥',
      remark: '已完成安装，待复核标定',
      createdAt: now - 20 * 86400000,
      updatedAt: now - 18 * 86400000,
    },
    {
      id: 'rpl_ltx01_st',
      instrumentId: 'ins_ltx01_st',
      reason: '超期未标定，更换为新型号',
      newSerialNo: 'FSS3B-20250506-24',
      date: daysAgo(60),
      state: '已复核',
      operator: '陈立群',
      remark: '复核标定合格，序列号已回写',
      createdAt: now - 60 * 86400000,
      updatedAt: now - 30 * 86400000,
    },
  ];

  await db.transaction(
    'rw',
    [db.arrays, db.stations, db.instruments, db.calibrations, db.replaces, db.dispatches, db.batches],
    async () => {
      const stamp = (offset: number): { createdAt: number; updatedAt: number } => ({
        createdAt: now + offset,
        updatedAt: now + offset,
      });

      const arrayRows: SeisArray[] = [];
      const stationRows: SeisStation[] = [];
      const instrumentRows: Instrument[] = [];
      const calibrationRows: Calibration[] = [];

      arrays.forEach((seed, arrayIndex) => {
        const { stations, ...arrayRest } = seed;
        arrayRows.push({ ...arrayRest, stationCount: stations.length, ...stamp(arrayIndex) });
        stations.forEach((stationSeed, stationIndex) => {
          const { instruments, ...stationRest } = stationSeed;
          stationRows.push({ ...stationRest, ...stamp(100 + arrayIndex * 100 + stationIndex) });
          instruments.forEach((instrumentSeed, instrumentIndex) => {
            const { calibrations, ...instrumentRest } = instrumentSeed;
            instrumentRows.push({
              ...instrumentRest,
              ...stamp(200 + arrayIndex * 200 + stationIndex * 50 + instrumentIndex),
            });
            calibrations.forEach((calibrationSeed, calibrationIndex) => {
              const verdict = judgeCalibration(
                instrumentRest.type,
                calibrationSeed.sensitivity,
                calibrationSeed.selfNoise
              );
              calibrationRows.push({
                ...calibrationSeed,
                responseVerdict: verdict,
                ...stamp(
                  400 + arrayIndex * 400 + stationIndex * 100 + instrumentIndex * 20 + calibrationIndex
                ),
              });
            });
          });
        });
      });

      // 旧标定按「标定日期 + 机构」切出历史出车批次并挂回台站（与升级迁移同一套规则）
      const legacy = cutLegacyCalibrations(calibrationRows, instrumentRows, stationRows);

      // 当前业务演示：一趟已出车（3 台已录结论 / 1 台退回 / 1 台对账失败），一趟待出车（名额将满，后面排队）
      const activeBatchRows: CalibBatch[] = [
        {
          id: 'bt_2026_03',
          code: 'JL2026-03',
          departDate: daysAgo(3),
          capacity: 4,
          agency: '省地震局计量站',
          state: '已出车',
          remark: '龙门峡方向第三趟，已返回',
          items: [
            {
              dispatchId: 'dsp_ltx03_bb',
              instrumentId: 'ins_ltx03_bb',
              stationCode: 'LTX03',
              serialNo: 'STS25-20230902-11',
              sensitivity: 2198.6,
              selfNoise: 1.98,
              verdict: '合格',
              returned: false,
              note: '脉冲响应合格，灵敏度年变化 -2.3%',
              createdAt: now - 3 * 86400000,
              updatedAt: now - 1 * 86400000,
            },
            {
              dispatchId: 'dsp_ltx02_bb',
              instrumentId: 'ins_ltx02_bb',
              stationCode: 'LTX02',
              serialNo: 'T120-20220315-07',
              sensitivity: 1012.3,
              selfNoise: 2.95,
              verdict: '不合格',
              returned: false,
              note: '灵敏度跌至区间下限附近，判不合格',
              createdAt: now - 3 * 86400000,
              updatedAt: now - 1 * 86400000,
            },
            {
              dispatchId: 'dsp_ltx01_st',
              instrumentId: 'ins_ltx01_st',
              stationCode: 'LTX01',
              serialNo: 'FSS3B-20210418-02',
              sensitivity: null,
              selfNoise: null,
              verdict: '待判定',
              returned: false,
              note: '报告尚未整理，先挂结论',
              createdAt: now - 3 * 86400000,
              updatedAt: now - 2 * 86400000,
            },
            {
              dispatchId: 'dsp_hx02_bb',
              instrumentId: 'ins_hx02_bb',
              stationCode: 'HX02',
              serialNo: 'HX02-WRONG-99',
              sensitivity: null,
              selfNoise: null,
              verdict: '待判定',
              returned: true,
              note: '现场登记序列号与运维班台账对不上，且仪器外观受损，随车退回',
              createdAt: now - 3 * 86400000,
              updatedAt: now - 1 * 86400000,
            },
          ],
          createdAt: now - 6 * 86400000,
          updatedAt: now - 1 * 86400000,
        },
        {
          id: 'bt_2026_04',
          code: 'JL2026-04',
          departDate: '2026-10-14',
          capacity: 2,
          agency: '省地震局计量站',
          state: '待出车',
          remark: '下一趟，名额 2，已满',
          items: [
            {
              dispatchId: 'dsp_hx01_bb',
              instrumentId: 'ins_hx01_bb',
              stationCode: 'HX01',
              serialNo: 'TC-20190925-03',
              sensitivity: null,
              selfNoise: null,
              verdict: '待判定',
              returned: false,
              note: '',
              createdAt: now - 1 * 86400000,
              updatedAt: now - 1 * 86400000,
            },
            {
              dispatchId: 'dsp_hx01_sm',
              instrumentId: 'ins_hx01_sm',
              stationCode: 'HX01',
              serialNo: 'EST-20190925-04',
              sensitivity: null,
              selfNoise: null,
              verdict: '待判定',
              returned: false,
              note: '',
              createdAt: now - 1 * 86400000,
              updatedAt: now - 1 * 86400000,
            },
          ],
          createdAt: now - 2 * 86400000,
          updatedAt: now - 1 * 86400000,
        },
      ];

      const activeDispatchRows: Dispatch[] = [
        {
          id: 'dsp_ltx03_bb',
          instrumentId: 'ins_ltx03_bb',
          stationId: 'stn_ltx_03',
          stationCode: 'LTX03',
          serialNo: 'STS25-20230902-11',
          sendDate: daysAgo(5),
          state: '已入库',
          batchId: 'bt_2026_03',
          queueOrder: 0,
          mismatchReason: '',
          returnReason: '',
          calibrationId: 'cal_active_ltx03_bb',
          operator: '周渝',
          remark: '随车返回后已回装 LTX03',
          ...stamp(600),
        },
        {
          id: 'dsp_ltx02_bb',
          instrumentId: 'ins_ltx02_bb',
          stationId: 'stn_ltx_02',
          stationCode: 'LTX02',
          serialNo: 'T120-20220315-07',
          sendDate: daysAgo(5),
          state: '已入库',
          batchId: 'bt_2026_03',
          queueOrder: 1,
          mismatchReason: '',
          returnReason: '',
          calibrationId: 'cal_active_ltx02_bb',
          operator: '周渝',
          remark: '不合格，已转更换提醒',
          ...stamp(601),
        },
        {
          id: 'dsp_ltx01_st',
          instrumentId: 'ins_ltx01_st',
          stationId: 'stn_ltx_01',
          stationCode: 'LTX01',
          serialNo: 'FSS3B-20210418-02',
          sendDate: daysAgo(5),
          state: '已出车',
          batchId: 'bt_2026_03',
          queueOrder: 2,
          mismatchReason: '',
          returnReason: '',
          calibrationId: '',
          operator: '周渝',
          remark: '等计量站补结论',
          ...stamp(602),
        },
        {
          id: 'dsp_hx02_bb',
          instrumentId: 'ins_hx02_bb',
          stationId: 'stn_hx_02',
          stationCode: 'HX02',
          serialNo: 'CMG-3E-20190926-05',
          sendDate: daysAgo(5),
          state: '对账失败',
          batchId: 'bt_2026_03',
          queueOrder: 3,
          mismatchReason: '序列号不一致',
          returnReason: '序列号对不上且外观受损，计量站仅退回这一台',
          calibrationId: '',
          operator: '林之遥',
          remark: '挂起待确认：以运维班台账为准重试',
          ...stamp(603),
        },
        {
          id: 'dsp_hx01_bb',
          instrumentId: 'ins_hx01_bb',
          stationId: 'stn_hx_01',
          stationCode: 'HX01',
          serialNo: 'TC-20190925-03',
          sendDate: daysAgo(2),
          state: '已排入',
          batchId: 'bt_2026_04',
          queueOrder: 0,
          mismatchReason: '',
          returnReason: '',
          calibrationId: '',
          operator: '陈立群',
          remark: '',
          ...stamp(604),
        },
        {
          id: 'dsp_hx01_sm',
          instrumentId: 'ins_hx01_sm',
          stationId: 'stn_hx_01',
          stationCode: 'HX01',
          serialNo: 'EST-20190925-04',
          sendDate: daysAgo(2),
          state: '已排入',
          batchId: 'bt_2026_04',
          queueOrder: 1,
          mismatchReason: '',
          returnReason: '',
          calibrationId: '',
          operator: '陈立群',
          remark: '',
          ...stamp(605),
        },
        {
          id: 'dsp_ltx02_st_q',
          instrumentId: 'ins_ltx02_st',
          stationId: 'stn_ltx_02',
          stationCode: 'LTX02',
          serialNo: 'L4C-20220315-08',
          sendDate: daysAgo(1),
          state: '排队中',
          batchId: '',
          queueOrder: 0,
          mismatchReason: '',
          returnReason: '',
          calibrationId: '',
          operator: '周渝',
          remark: 'JL2026-04 名额已满，排队等下一趟',
          ...stamp(606),
        },
        {
          id: 'dsp_ltx01_bb_q',
          instrumentId: 'ins_ltx01_bb',
          stationId: 'stn_ltx_01',
          stationCode: 'LTX01',
          serialNo: 'CMG-3E-20210418-01',
          sendDate: today,
          state: '排队中',
          batchId: '',
          queueOrder: 1,
          mismatchReason: '',
          returnReason: '',
          calibrationId: '',
          operator: '陈立群',
          remark: '刚登记，排在队尾',
          ...stamp(607),
        },
      ];

      // 当前在途批次新产生的两条标定结论（与历史切批共用 calibrations 表）
      const activeCalibrationRows: Calibration[] = [
        {
          id: 'cal_active_ltx03_bb',
          instrumentId: 'ins_ltx03_bb',
          date: daysAgo(1),
          sensitivity: 2198.6,
          selfNoise: 1.98,
          responseVerdict: '合格',
          operator: '林之遥',
          agency: '省地震局计量站',
          remark: 'JL2026-03 出车标定，脉冲响应合格',
          ...stamp(610),
        },
        {
          id: 'cal_active_ltx02_bb',
          instrumentId: 'ins_ltx02_bb',
          date: daysAgo(1),
          sensitivity: 1012.3,
          selfNoise: 2.95,
          responseVerdict: '不合格',
          operator: '林之遥',
          agency: '省地震局计量站',
          remark: 'JL2026-03 出车标定，灵敏度偏低',
          ...stamp(611),
        },
      ];

      await db.arrays.bulkPut(arrayRows);
      await db.stations.bulkPut(stationRows);
      await db.instruments.bulkPut(instrumentRows);
      await db.calibrations.bulkPut([...calibrationRows, ...activeCalibrationRows]);
      await db.replaces.bulkPut(replaces);
      await db.batches.bulkPut([...legacy.batches, ...activeBatchRows]);
      await db.dispatches.bulkPut([...legacy.dispatches, ...activeDispatchRows]);
    }
  );
}

/** 打开数据库并幂等播种：仅当台阵表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open();
  const count = await db.arrays.count();
  if (count === 0) {
    await seedDemoData();
  }
  stampDbVersion();
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.arrays, db.stations, db.instruments, db.calibrations, db.replaces, db.dispatches, db.batches],
    async () => {
      await Promise.all([
        db.arrays.clear(),
        db.stations.clear(),
        db.instruments.clear(),
        db.calibrations.clear(),
        db.replaces.clear(),
        db.dispatches.clear(),
        db.batches.clear(),
      ]);
    }
  );
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDemoData();
  clearOrphanCalibrations();
}

/** 统计各表行数，供页脚概览与几何页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [arrays, stations, instruments, calibrations, replaces, dispatches, batches] = await Promise.all([
    db.arrays.count(),
    db.stations.count(),
    db.instruments.count(),
    db.calibrations.count(),
    db.replaces.count(),
    db.dispatches.count(),
    db.batches.count(),
  ]);
  return { arrays, stations, instruments, calibrations, replaces, dispatches, batches };
}

/** 读取升级时切不出来的旧标定（单列待人工确认） */
export function readOrphanCalibrations(): Array<{
  calibration: Calibration;
  reason: string;
}> {
  try {
    const raw = localStorage.getItem(LS_KEYS.orphanCalibrations);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<{ calibration: Calibration; reason: string }>;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 人工确认后清掉单列提示（原始标定记录保留在校准表中） */
export function clearOrphanCalibrations(): void {
  try {
    localStorage.removeItem(LS_KEYS.orphanCalibrations);
  } catch {
    // 忽略
  }
}

/** 写入结构版本号到 localStorage，便于几何页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION));
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso);
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt);
  } catch {
    return null;
  }
}

export function readLastArrayId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastArrayId);
  } catch {
    return null;
  }
}

export function writeLastArrayId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastArrayId);
    else localStorage.setItem(LS_KEYS.lastArrayId, id);
  } catch {
    // 忽略
  }
}
