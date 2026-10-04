/**
 * 出车批次（计量站侧）：按车次记录出车日期、能带台数与逐台结论。
 * 批次有名额（capacity），运维班送检登记按 FIFO 排队进入筹备中的批次；
 * 批次出车后锁定，不再加台。逐台结论按 台站码 + 序列号 与运维班送检登记对账，
 * 对上了才把结论写回仪器（Calibration），对不上挂起等确认、不写结论。
 */
import type { ResponseVerdict } from '@/types/calibration';

/** 批次状态 */
export type BatchStatus = '筹备中' | '已出车' | '已完成';

export const BATCH_STATUSES: BatchStatus[] = ['筹备中', '已出车', '已完成'];

/** 批次明细对账状态 */
export type BatchItemStatus =
  | '待对账' // 已入批次，结论待录入 / 待对账
  | '已对账' // 与运维班送检登记对上，结论已写回仪器
  | '对账失败' // 对不上，挂起等确认，未写结论
  | '已退回'; // 计量站退回该台（其余照旧入库）

export const BATCH_ITEM_STATUSES: BatchItemStatus[] = ['待对账', '已对账', '对账失败', '已退回'];

/** 出车批次 */
export interface DispatchBatch {
  id: string;
  /** 批次号（如 PC20250420-01） */
  batchNo: string;
  /** 出车日期 */
  dispatchDate: string;
  /** 能带台数（名额） */
  capacity: number;
  /** 状态 */
  status: BatchStatus;
  /** 计量机构 */
  agency: string;
  /** 出车路线 / 前往台阵备注 */
  routeNote: string;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 批次明细：逐台结论（计量站侧记录） */
export interface BatchItem {
  id: string;
  /** 所属批次 */
  batchId: string;
  /** 台站码（计量站记录，对账业务键） */
  stationCode: string;
  /** 序列号（计量站记录，对账业务键） */
  serialNo: string;
  /** 对账解析到的仪器（对上后回填） */
  instrumentId: string | null;
  /** 灵敏度（V·s/m） */
  sensitivity: number;
  /** 自噪 */
  selfNoise: number;
  /** 脉冲响应结论 */
  responseVerdict: ResponseVerdict;
  /** 标定人 */
  operator: string;
  /** 对账状态 */
  reconStatus: BatchItemStatus;
  /** 挂起原因（对账失败时填写） */
  reconNote: string;
  /** 对账写入的标定记录 id（已对账时回填） */
  calibrationId: string | null;
  /** 退回时间（已退回时填写） */
  returnedAt: number | null;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 批次草稿 */
export interface BatchDraft {
  batchNo: string;
  dispatchDate: string;
  capacity: number;
  agency: string;
  routeNote: string;
  remark: string;
}

export function createEmptyBatchDraft(): BatchDraft {
  return {
    batchNo: '',
    dispatchDate: new Date().toISOString().slice(0, 10),
    capacity: 4,
    agency: '省地震局计量站',
    routeNote: '',
    remark: '',
  };
}

/** 逐台结论草稿 */
export interface BatchItemDraft {
  stationCode: string;
  serialNo: string;
  sensitivity: number;
  selfNoise: number;
  responseVerdict: ResponseVerdict;
  operator: string;
  remark: string;
}

export function createEmptyBatchItemDraft(): BatchItemDraft {
  return {
    stationCode: '',
    serialNo: '',
    sensitivity: 0,
    selfNoise: 0,
    responseVerdict: '待判定',
    operator: '',
    remark: '',
  };
}

export function batchStatusColor(status: BatchStatus): string {
  switch (status) {
    case '筹备中':
      return 'blue';
    case '已出车':
      return 'orange';
    case '已完成':
      return 'green';
    default:
      return 'default';
  }
}

export function batchItemStatusColor(status: BatchItemStatus): string {
  switch (status) {
    case '已对账':
      return 'green';
    case '待对账':
      return 'blue';
    case '对账失败':
      return 'red';
    case '已退回':
      return 'default';
    default:
      return 'default';
  }
}
