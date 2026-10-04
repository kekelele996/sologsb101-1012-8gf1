/**
 * 对账与派单引擎（纯函数，不触库）。
 * - 对账：计量站逐台结论（BatchItem）与运维班送检登记（Submission）按 台站码 + 序列号 匹配，
 *   对上了才允许把结论写回仪器；对不上挂起等确认，不写结论。
 * - 派单：批次有名额（capacity），送检登记按 FIFO 进入筹备中的批次；满了排队等下一趟，
 *   已出车的批次锁定不再加台。
 * - 历史切批：旧标定没有出车批次，升级时按 标定日期 + 机构 切出批次挂回台站；切不出来的单列。
 */
import type { Calibration, ResponseVerdict } from '@/types/calibration';
import type { Instrument } from '@/types/instrument';
import type { SeisStation } from '@/types/station';
import type { Submission, SubmissionStatus } from '@/types/submission';
import type { BatchItem, BatchItemStatus, DispatchBatch } from '@/types/dispatch';

/* ------------------------------ 批次号 ------------------------------ */

/** 生成批次号：PC + yyyyMMdd + 两位序号 */
export function makeBatchNo(date: string, seq = 1): string {
  const compact = (date || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
  return `PC${compact}-${String(seq).padStart(2, '0')}`;
}

/* ------------------------------ 对账 ------------------------------ */

export interface ReconcileOutcome {
  ok: boolean;
  /** 对账后的明细状态 */
  itemStatus: BatchItemStatus;
  /** 对账后的送检登记状态 */
  submissionStatus: SubmissionStatus | null;
  /** 挂起原因（失败时填写） */
  reason: string;
  /** 匹配到的送检登记 */
  submission: Submission | null;
  /** 解析到的仪器 */
  instrument: Instrument | null;
  /** 是否需要新建标定结论（false 表示复用已有） */
  shouldWriteCalibration: boolean;
}

/**
 * 单台对账：按 台站码 + 序列号 匹配运维班送检登记，并解析到仪器。
 * 不写库，只返回结果；落库由 slice 动作完成。
 */
export function reconcileItem(
  item: BatchItem,
  submissions: Submission[],
  instruments: Instrument[]
): ReconcileOutcome {
  const stationCode = item.stationCode.trim();
  const serialNo = item.serialNo.trim();

  if (!stationCode || !serialNo) {
    return {
      ok: false,
      itemStatus: '对账失败',
      submissionStatus: null,
      reason: '台站码或序列号为空，无法与运维班对账',
      submission: null,
      instrument: null,
      shouldWriteCalibration: false,
    };
  }

  // 运维班送检登记：同 台站码 + 序列号，且未退回
  const matched = submissions.find(
    (row) =>
      row.stationCode.trim() === stationCode &&
      row.serialNo.trim() === serialNo &&
      row.status !== '已退回'
  );

  if (!matched) {
    return {
      ok: false,
      itemStatus: '对账失败',
      submissionStatus: null,
      reason: `运维送检登记中无「${stationCode} / ${serialNo}」，请运维班补登记后按运维侧重试`,
      submission: null,
      instrument: null,
      shouldWriteCalibration: false,
    };
  }

  // 解析仪器：优先送检登记关联的仪器，其次按序列号在运维台账查
  const instrument =
    instruments.find((row) => row.id === matched.instrumentId) ??
    instruments.find((row) => row.serialNo.trim() === serialNo) ??
    null;

  if (!instrument) {
    return {
      ok: false,
      itemStatus: '对账失败',
      submissionStatus: '对账失败',
      reason: `「${stationCode} / ${serialNo}」在运维台账中查不到对应仪器，无法写回结论`,
      submission: matched,
      instrument: null,
      shouldWriteCalibration: false,
    };
  }

  // 已对账过：幂等，复用已有标定结论，不重复写
  if (matched.status === '已对账') {
    return {
      ok: true,
      itemStatus: '已对账',
      submissionStatus: '已对账',
      reason: '',
      submission: matched,
      instrument,
      shouldWriteCalibration: false,
    };
  }

  return {
    ok: true,
    itemStatus: '已对账',
    submissionStatus: '已对账',
    reason: '',
    submission: matched,
    instrument,
    shouldWriteCalibration: true,
  };
}

/** 批量对账：返回每台的结果（不写库） */
export function reconcileAll(
  items: BatchItem[],
  submissions: Submission[],
  instruments: Instrument[]
): Map<string, ReconcileOutcome> {
  const outcomes = new Map<string, ReconcileOutcome>();
  items.forEach((item) => {
    outcomes.set(item.id, reconcileItem(item, submissions, instruments));
  });
  return outcomes;
}

/* ------------------------------ 派单（名额排队） ------------------------------ */

export interface Assignment {
  submissionId: string;
  batchId: string;
}

/**
 * FIFO 派单：把「待安排」的送检登记按时间顺序派入筹备中的批次。
 * - 已出车 / 已完成的批次锁定，不再加台（照旧不动）。
 * - 每个批次最多派到 capacity 台；满了排队等下一趟（返回的 assignments 里没有它）。
 * - 已安排 / 已对账 / 对账失败 / 已退回的登记不动。
 * 返回派单结果（纯计算，不写库）。
 */
export function planAssignments(
  submissions: Submission[],
  batches: DispatchBatch[],
  items: BatchItem[]
): Assignment[] {
  const openBatches = batches
    .filter((batch) => batch.status === '筹备中')
    .sort((a, b) => a.dispatchDate.localeCompare(b.dispatchDate) || a.createdAt - b.createdAt);

  // 每个筹备批次已占用的名额（明细条数，退回的不占名额）
  const usedSlots = new Map<string, number>();
  items.forEach((item) => {
    if (item.reconStatus === '已退回') return;
    usedSlots.set(item.batchId, (usedSlots.get(item.batchId) ?? 0) + 1);
  });

  const queue = submissions
    .filter((row) => row.status === '待安排' && row.batchId === null)
    .sort((a, b) => a.createdAt - b.createdAt);

  const assignments: Assignment[] = [];
  let cursor = 0;
  for (const submission of queue) {
    while (cursor < openBatches.length) {
      const batch = openBatches[cursor];
      const used = usedSlots.get(batch.id) ?? 0;
      if (used < batch.capacity) {
        assignments.push({ submissionId: submission.id, batchId: batch.id });
        usedSlots.set(batch.id, used + 1);
        break;
      }
      cursor += 1; // 该批满了，换下一趟
    }
    // cursor 耗尽仍排不上 → 留在待安排，等下一趟
  }
  return assignments;
}

/* ------------------------------ 历史数据切批次 ------------------------------ */

export interface LegacySliceResult {
  batches: DispatchBatch[];
  items: BatchItem[];
  /** 切不出来的标定（缺日期 / 缺机构 / 找不到仪器台站），单列 */
  orphans: Calibration[];
}

/**
 * 旧标定切批次：按 标定日期 + 机构 分组，每组切一个出车批次（已完成），
 逐台结论挂回对应台站（明细带 stationCode / serialNo / instrumentId）。
 * 切不出来的（日期或机构缺失、仪器台站对不上）列入 orphans 单独展示。
 */
export function sliceLegacyBatches(
  calibrations: Calibration[],
  instruments: Instrument[],
  stations: SeisStation[]
): LegacySliceResult {
  const instrumentById = new Map(instruments.map((row) => [row.id, row]));
  const stationById = new Map(stations.map((row) => [row.id, row]));

  const groups = new Map<string, { batch: DispatchBatch; items: BatchItem[] }>();
  const orphans: Calibration[] = [];

  calibrations.forEach((cal) => {
    const instrument = instrumentById.get(cal.instrumentId);
    const station = instrument ? stationById.get(instrument.stationId) : undefined;
    const date = (cal.date ?? '').trim();
    const agency = (cal.agency ?? '').trim();

    if (!instrument || !station || !date || !agency) {
      orphans.push(cal);
      return;
    }

    const key = `${date}__${agency}`;
    let group = groups.get(key);
    if (!group) {
      const seq = groups.size + 1;
      const batch: DispatchBatch = {
        id: `bat_legacy_${key.replace(/[^0-9a-zA-Z一-龥]/g, '_')}`,
        batchNo: makeBatchNo(date, seq),
        dispatchDate: date,
        capacity: 0, // 占位，建组后按明细数回填
        status: '已完成',
        agency,
        routeNote: '历史标定切批',
        remark: '由旧标定记录按日期+机构切出',
        createdAt: cal.createdAt,
        updatedAt: cal.updatedAt,
      };
      group = { batch, items: [] };
      groups.set(key, group);
    }

    group.items.push({
      id: `bit_legacy_${cal.id}`,
      batchId: group.batch.id,
      stationCode: station.code,
      serialNo: instrument.serialNo,
      instrumentId: instrument.id,
      sensitivity: cal.sensitivity,
      selfNoise: cal.selfNoise,
      responseVerdict: cal.responseVerdict,
      operator: cal.operator,
      reconStatus: '已对账',
      reconNote: '',
      calibrationId: cal.id,
      returnedAt: null,
      remark: cal.remark,
      createdAt: cal.createdAt,
      updatedAt: cal.updatedAt,
    });
  });

  const batches: DispatchBatch[] = [];
  const items: BatchItem[] = [];
  groups.forEach((group) => {
    group.batch.capacity = group.items.length; // 历史批次名额 = 实际台数
    batches.push(group.batch);
    items.push(...group.items);
  });

  batches.sort((a, b) => a.dispatchDate.localeCompare(b.dispatchDate));
  return { batches, items, orphans };
}

/** 统计批次名额占用（不含退回） */
export function batchUsedSlots(items: BatchItem[], batchId: string): number {
  return items.filter((row) => row.batchId === batchId && row.reconStatus !== '已退回').length;
}

/** 逐台结论是否已录入（灵敏度非 0 或有明确结论） */
export function isConclusionFilled(item: BatchItem): boolean {
  return Number.isFinite(item.sensitivity) && item.sensitivity > 0;
}

/**
 * 旧数据中切不出来的标定：没挂到任何批次明细，且缺日期 / 缺机构 / 找不到仪器台站。
 * 升级切批后，这些需要单列出来人工确认。
 */
export function findLegacyOrphans(
  calibrations: Calibration[],
  items: BatchItem[],
  instruments: Instrument[],
  stations: SeisStation[]
): Calibration[] {
  const instrumentById = new Map(instruments.map((row) => [row.id, row]));
  const stationById = new Map(stations.map((row) => [row.id, row]));
  const linkedIds = new Set(
    items.map((row) => row.calibrationId).filter((id): id is string => typeof id === 'string' && id.length > 0)
  );
  return calibrations.filter((cal) => {
    if (linkedIds.has(cal.id)) return false;
    const instrument = instrumentById.get(cal.instrumentId);
    const station = instrument ? stationById.get(instrument.stationId) : undefined;
    const date = (cal.date ?? '').trim();
    const agency = (cal.agency ?? '').trim();
    return !instrument || !station || !date || !agency;
  });
}

export type { ResponseVerdict };
