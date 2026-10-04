/**
 * 送检登记（运维班侧）：按台站记录「哪台仪器送去标定」。
 * 业务键为 台站码 + 序列号，与计量站的出车批次逐台结论按此对账。
 * 安装位置在登记时从仪器档案带出，对账成功后把结论写回该仪器。
 */

/** 送检登记状态 */
export type SubmissionStatus =
  | '待安排' // 已登记，排队等下一趟车
  | '已安排' // 已派进某个筹备中批次
  | '已出车' // 批次已出车，仪器在计量站
  | '已对账' // 与计量站逐台结论对上，结论已写回仪器
  | '对账失败' // 对账对不上（挂起，等确认），未写结论
  | '已退回'; // 计量站退回该台，其余照旧入库

export const SUBMISSION_STATUSES: SubmissionStatus[] = [
  '待安排',
  '已安排',
  '已出车',
  '已对账',
  '对账失败',
  '已退回',
];

/** 送检登记：运维班按台站提交的送检凭据 */
export interface Submission {
  id: string;
  /** 关联仪器（运维台账中的安装位置） */
  instrumentId: string;
  /** 台站 id（登记时从仪器带出，便于按台站筛选） */
  stationId: string;
  /** 台站码（业务键，对账用） */
  stationCode: string;
  /** 序列号（业务键，对账用） */
  serialNo: string;
  /** 送检日期 */
  submittedDate: string;
  /** 状态 */
  status: SubmissionStatus;
  /** 被派入的出车批次（待安排 / 排队时为 null） */
  batchId: string | null;
  /** 挂起 / 退回原因（对账失败或退回时填写） */
  reconNote: string;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 送检登记草稿（存于 submissionSlice） */
export interface SubmissionDraft {
  instrumentId: string;
  submittedDate: string;
  remark: string;
}

export function createEmptySubmissionDraft(): SubmissionDraft {
  return {
    instrumentId: '',
    submittedDate: new Date().toISOString().slice(0, 10),
    remark: '',
  };
}

/** 状态对应的徽标颜色（与 Ant Design Tag color 对齐） */
export function submissionStatusColor(status: SubmissionStatus): string {
  switch (status) {
    case '已对账':
      return 'green';
    case '已安排':
    case '已出车':
      return 'blue';
    case '对账失败':
      return 'red';
    case '已退回':
      return 'default';
    case '待安排':
    default:
      return 'orange';
  }
}
