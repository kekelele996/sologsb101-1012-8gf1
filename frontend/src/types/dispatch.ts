/**
 * 送检登记（运维班侧台账）
 * - 运维班按台站记录仪器安装位置（台站码）与送检登记（序列号、送检日期）
 * - 计量站侧按出车批次逐台登记，两边按「台站码 + 序列号」对账
 * - 名额满了自动排队等下一趟；对不上的先挂起待确认，不写结论
 */

/** 送检登记状态 */
export type DispatchState = '排队中' | '已排入' | '已出车' | '已入库' | '已退回' | '对账失败';

export const DISPATCH_STATES: DispatchState[] = [
  '排队中',
  '已排入',
  '已出车',
  '已入库',
  '已退回',
  '对账失败',
];

/** 终态：不再参与对账（已入库仪器已回台站；已退回仅这一台退出本趟） */
export const DISPATCH_FINAL_STATES: DispatchState[] = ['已入库', '已退回'];

/** 台账来源（对账以运维班侧为准） */
export const LEDGER_OWNER = {
  ops: '运维班',
  metrology: '计量站',
} as const;

/** 送检出车/对账结果异常原因 */
export type DispatchMismatchReason =
  | '计量站未登记'
  | '台站码不一致'
  | '序列号不一致'
  | '仪器档案缺失'
  | '';

/** 送检登记：运维班把台站上的仪器登记送检 */
export interface Dispatch {
  id: string;
  /** 被送检仪器（可能在登记后被删除，此时仅保留台账快照） */
  instrumentId: string;
  /** 所属台站 */
  stationId: string;
  /** 台站码（对账基准之一，取登记时快照） */
  stationCode: string;
  /** 序列号（对账基准之一，取登记时快照，全局唯一） */
  serialNo: string;
  /** 送检日期（YYYY-MM-DD） */
  sendDate: string;
  /** 送检状态 */
  state: DispatchState;
  /** 排入的出车批次（排队中为空） */
  batchId: string;
  /** 排队序号（同批次内按登记先后，越小越靠前） */
  queueOrder: number;
  /** 对账失败原因，空表示无异常 */
  mismatchReason: DispatchMismatchReason | '';
  /** 退回原因（计量站只退这一台时填写） */
  returnReason: string;
  /** 对账入库后生成 / 关联的标定记录 id（旧数据迁移时挂回原标定） */
  calibrationId: string;
  /** 经办人（运维班） */
  operator: string;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 送检登记表单草稿 */
export interface DispatchDraft {
  stationId: string;
  instrumentId: string;
  sendDate: string;
  operator: string;
  remark: string;
}

export function createEmptyDispatchDraft(): DispatchDraft {
  return {
    stationId: '',
    instrumentId: '',
    sendDate: new Date().toISOString().slice(0, 10),
    operator: '',
    remark: '',
  };
}

/** 送检台账页筛选条件（存于 dispatchSlice） */
export interface DispatchFilterState {
  keyword: string;
  states: DispatchState[];
  batchId: string;
}

export function createEmptyDispatchFilter(): DispatchFilterState {
  return { keyword: '', states: [], batchId: '' };
}

/** 各状态对应的徽标颜色（antd Tag color） */
export const DISPATCH_STATE_COLORS: Record<DispatchState, string> = {
  排队中: 'default',
  已排入: 'blue',
  已出车: 'processing',
  已入库: 'green',
  已退回: 'orange',
  对账失败: 'error',
};

/** 状态文案说明（页面提示用） */
export const DISPATCH_STATE_HINTS: Record<DispatchState, string> = {
  排队中: '本趟名额已满，按登记先后等下一趟',
  已排入: '已占用某批次名额，批次尚未出车，可撤回',
  已出车: '批次已出车，记录冻结不可改动',
  已入库: '对账一致且有逐台结论，仪器照旧回库',
  已退回: '计量站仅退回这一台，其余仪器照旧入库',
  对账失败: '台站码或序列号对不上，挂起待确认，暂不写结论',
};
