/**
 * 出车批次（计量站侧台账）
 * - 计量站出车到台阵做标定，一趟能带的仪器有限（capacity 名额）
 * - 按出车批次记出车日期、能带台数和逐台结论
 * - 已出车批次照旧不动；退回只退某一台，其余照旧入库
 */
import type { ResponseVerdict } from '@/types/calibration';

/** 出车批次状态 */
export type BatchState = '待出车' | '已出车';

export const BATCH_STATES: BatchState[] = ['待出车', '已出车'];

/** 逐台结论：计量站出车回来后按台填写 */
export interface BatchItemVerdict {
  /** 对应运维班送检登记 id（对账主键之一） */
  dispatchId: string;
  /** 仪器 id（对账通过后回填） */
  instrumentId: string;
  /** 台站码（对账主键之一，计量站现场记录） */
  stationCode: string;
  /** 序列号（对账主键之一，计量站现场记录） */
  serialNo: string;
  /** 灵敏度（V·s/m） */
  sensitivity: number | null;
  /** 自噪 */
  selfNoise: number | null;
  /** 逐台标定结论；对账未确认前保持「待判定」，不写结论 */
  verdict: ResponseVerdict;
  /** 该台是否被计量站退回（只退这一台，不影响其余台入库） */
  returned: boolean;
  /** 退回/备注说明 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

/** 出车批次：计量站一趟出车的台账 */
export interface CalibBatch {
  id: string;
  /** 批次号，如 PC2026-03 */
  code: string;
  /** 出车日期（YYYY-MM-DD） */
  departDate: string;
  /** 一趟能带台数（名额） */
  capacity: number;
  /** 标定机构（旧数据切批次时按机构分组） */
  agency: string;
  /** 状态：待出车可继续排入 / 已出车冻结照旧 */
  state: BatchState;
  /** 逐台结论（已出车后由计量站登记） */
  items: BatchItemVerdict[];
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 批次表单草稿 */
export interface BatchDraft {
  code: string;
  departDate: string;
  capacity: number;
  agency: string;
  remark: string;
}

export function createEmptyBatchDraft(): BatchDraft {
  return {
    code: '',
    departDate: new Date().toISOString().slice(0, 10),
    capacity: 4,
    agency: '省地震局计量站',
    remark: '',
  };
}

/** 批次页筛选条件 */
export interface BatchFilterState {
  keyword: string;
  states: BatchState[];
}

export function createEmptyBatchFilter(): BatchFilterState {
  return { keyword: '', states: [] };
}

/**
 * 名额使用：已排入且未退回的台数占用名额；排队中的不占名额。
 * 退回只释放这一台的名额（但已出车批次照旧不动，不做补排）。
 */
export function occupiedSeats(batch: CalibBatch): number {
  return batch.items.filter((item) => !item.returned).length;
}

/** 剩余名额 */
export function freeSeats(batch: CalibBatch): number {
  return Math.max(0, batch.capacity - occupiedSeats(batch));
}

/** 是否还有名额 */
export function hasFreeSeat(batch: CalibBatch): boolean {
  return batch.state === '待出车' && freeSeats(batch) > 0;
}
