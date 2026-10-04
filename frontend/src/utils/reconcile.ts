/**
 * 两侧台账对账：运维班送检登记（台站码 + 序列号）对计量站出车批次逐台记录。
 * 规则：
 * - 按「台站码 + 序列号」两边比对，任一对不上先挂起（对账失败）等确认，不写结论；
 * - 对账以运维班这侧为准（运维班记仪器安装位置，仪器档案挂在台站）；
 * - 计量站退回某台只退这一台，其余照旧入库；
 * - 旧数据没有出车批次，升级时按「标定日期 + 机构」切批次挂回台站，切不出来的单列。
 */
import type { Dispatch, DispatchMismatchReason } from '@/types/dispatch';
import type { BatchItemVerdict, CalibBatch } from '@/types/batch';
import type { Calibration, ResponseVerdict } from '@/types/calibration';
import type { Instrument } from '@/types/instrument';
import type { SeisStation } from '@/types/station';

/** 单台对账结果 */
export interface ReconcileOutcome {
  ok: boolean;
  reason: DispatchMismatchReason;
}

/** 规范化对账键（去空格、序列号统一大写） */
export function reconcileKey(stationCode: string, serialNo: string): string {
  return `${stationCode.trim().toUpperCase()}::${serialNo.trim().toUpperCase()}`;
}

/** 运维班侧对账键（以仪器安装位置为准） */
export function opsKey(dispatch: Pick<Dispatch, 'stationCode' | 'serialNo'>): string {
  return reconcileKey(dispatch.stationCode, dispatch.serialNo);
}

/** 计量站侧对账键（现场记录的台站码与序列号） */
export function stationKey(stationCode: string, serialNo: string): string {
  return reconcileKey(stationCode, serialNo);
}

/**
 * 对单台做对账：以运维班登记的台站码 / 序列号为准，
 * 仪器档案必须存在且序列号仍与登记一致（仪器可能在送检后被更换回写）。
 */
export function reconcileOne(
  dispatch: Dispatch,
  item: Pick<BatchItemVerdict, 'stationCode' | 'serialNo'>,
  instrument: Instrument | undefined,
  station: SeisStation | undefined
): ReconcileOutcome {
  if (!instrument || !station) {
    return { ok: false, reason: '仪器档案缺失' };
  }
  if (instrument.stationId !== dispatch.stationId) {
    return { ok: false, reason: '台站码不一致' };
  }
  if (station.code.trim().toUpperCase() !== dispatch.stationCode.trim().toUpperCase()) {
    return { ok: false, reason: '台站码不一致' };
  }
  if (instrument.serialNo.trim().toUpperCase() !== dispatch.serialNo.trim().toUpperCase()) {
    return { ok: false, reason: '序列号不一致' };
  }
  if (item.stationCode.trim().toUpperCase() !== dispatch.stationCode.trim().toUpperCase()) {
    return { ok: false, reason: '台站码不一致' };
  }
  if (item.serialNo.trim().toUpperCase() !== dispatch.serialNo.trim().toUpperCase()) {
    return { ok: false, reason: '序列号不一致' };
  }
  return { ok: true, reason: '' };
}

/** 对账行：挂在批次视图上，标注每台与运维班侧是否一致 */
export interface BatchReconcileRow {
  item: BatchItemVerdict;
  dispatch: Dispatch | null;
  /** 与运维班台站码 / 序列号比对是否一致 */
  stationCodeMatch: boolean;
  serialNoMatch: boolean;
  instrumentFound: boolean;
  /** 是否可写结论（对账一致才可写） */
  verdictWritable: boolean;
}

/** 计量站侧浏览：把批次逐台记录与运维班送检登记对账 */
export function buildBatchReconcileRows(
  batch: CalibBatch,
  dispatchIndex: Map<string, Dispatch>,
  instruments: Instrument[],
  stations: SeisStation[]
): BatchReconcileRow[] {
  const instrumentIndex = new Map(instruments.map((row) => [row.id, row]));
  const stationIndex = new Map(stations.map((row) => [row.id, row]));
  return batch.items.map((item) => {
    const dispatch = dispatchIndex.get(item.dispatchId) ?? null;
    const instrument = item.instrumentId ? instrumentIndex.get(item.instrumentId) : undefined;
    const station = instrument ? stationIndex.get(instrument.stationId) : undefined;
    const codeMatch =
      !!dispatch && item.stationCode.trim().toUpperCase() === dispatch.stationCode.trim().toUpperCase();
    const serialMatch =
      !!dispatch && item.serialNo.trim().toUpperCase() === dispatch.serialNo.trim().toUpperCase();
    const found = !!instrument && !!station;
    return {
      item,
      dispatch,
      stationCodeMatch: codeMatch,
      serialNoMatch: serialMatch,
      instrumentFound: found,
      verdictWritable: codeMatch && serialMatch && found,
    };
  });
}

/** 运维班侧浏览：送检登记当前所处的对账状态 */
export type OpsReconcileStatus =
  | '未排入'
  | '待出车'
  | '待结论'
  | '结论已录'
  | '已退回'
  | '已入库'
  | '对账失败';

export function describeOpsStatus(dispatch: Dispatch, batch: CalibBatch | null): OpsReconcileStatus {
  switch (dispatch.state) {
    case '排队中':
      return '未排入';
    case '已退回':
      return '已退回';
    case '已入库':
      return '已入库';
    case '对账失败':
      return '对账失败';
    case '已排入':
      return '待出车';
    case '已出车':
      if (!batch) return '待出车';
      return batch.items.some(
        (item) => item.dispatchId === dispatch.id && item.verdict !== '待判定' && !item.returned
      )
        ? '结论已录'
        : '待结论';
    default:
      return '未排入';
  }
}

/* ------------------------- 旧数据升级：切批次挂回台站 ------------------------- */

/** 切不出来的旧标定（仪器或台站档案缺失，单列） */
export interface OrphanCalibration {
  calibration: Calibration;
  reason: DispatchMismatchReason;
}

/** 旧标定按「标定日期 + 机构」切出的历史批次与送检登记 */
export interface LegacyCutResult {
  batches: CalibBatch[];
  dispatches: Dispatch[];
  /** 切不出来的旧标定，单列等人工确认 */
  orphans: OrphanCalibration[];
}

/** 同一天同一机构视为一趟出车（旧数据没有出车批次，按此切分） */
function legacyGroupKey(date: string, agency: string): string {
  return `${date}::${agency.trim() || '未填写机构'}`;
}

/**
 * 把旧标定切回历史批次：
 * 标定日期 + 机构 相同的记录归入同一趟出车；
 * 每条标定对应一台仪器、挂回其安装台站；找不到仪器/台站的单列。
 */
export function cutLegacyCalibrations(
  calibrations: Calibration[],
  instruments: Instrument[],
  stations: SeisStation[]
): LegacyCutResult {
  const instrumentIndex = new Map(instruments.map((row) => [row.id, row]));
  const stationIndex = new Map(stations.map((row) => [row.id, row]));
  const orphans: OrphanCalibration[] = [];
  const groups = new Map<
    string,
    { date: string; agency: string; rows: Array<{ calibration: Calibration; instrument: Instrument; station: SeisStation }> }
  >();

  calibrations.forEach((calibration) => {
    const instrument = instrumentIndex.get(calibration.instrumentId);
    const station = instrument ? stationIndex.get(instrument.stationId) : undefined;
    if (!instrument || !station) {
      orphans.push({ calibration, reason: '仪器档案缺失' });
      return;
    }
    const key = legacyGroupKey(calibration.date, calibration.agency);
    const group = groups.get(key) ?? { date: calibration.date, agency: calibration.agency, rows: [] };
    group.rows.push({ calibration, instrument, station });
    groups.set(key, group);
  });

  const batches: CalibBatch[] = [];
  const dispatches: Dispatch[] = [];

  Array.from(groups.entries())
    .sort((a, b) => a[1].date.localeCompare(b[1].date) || a[1].agency.localeCompare(b[1].agency, 'zh-Hans-CN'))
    .forEach(([, group], groupIndex) => {
      const seq = groupIndex + 1;
      const batchId = `bt_legacy_${group.date.replace(/-/g, '')}_${seq}`;
      const batchCode = `历史${group.date.replace(/-/g, '').slice(0, 6)}-${String(seq).padStart(2, '0')}`;
      const items: BatchItemVerdict[] = [];
      group.rows
        .sort((a, b) => a.station.code.localeCompare(b.station.code, 'zh-Hans-CN'))
        .forEach(({ calibration, instrument, station }, rowIndex) => {
          const dispatchId = `dsp_legacy_${calibration.id}`;
          const verdict: ResponseVerdict = calibration.responseVerdict;
          items.push({
            dispatchId,
            instrumentId: instrument.id,
            stationCode: station.code,
            serialNo: instrument.serialNo,
            sensitivity: calibration.sensitivity,
            selfNoise: calibration.selfNoise,
            verdict,
            returned: false,
            note: `旧标定迁移（${calibration.operator || '未署名'}）：${calibration.remark || ''}`.trim(),
            createdAt: calibration.createdAt,
            updatedAt: calibration.updatedAt,
          });
          dispatches.push({
            id: dispatchId,
            instrumentId: instrument.id,
            stationId: station.id,
            stationCode: station.code,
            serialNo: instrument.serialNo,
            sendDate: calibration.date,
            state: '已入库',
            batchId,
            queueOrder: rowIndex,
            mismatchReason: '',
            returnReason: '',
            calibrationId: calibration.id,
            operator: calibration.operator,
            remark: `升级时按标定日期 + 机构切批次挂回（${group.agency || '未填写机构'}）`,
            createdAt: calibration.createdAt,
            updatedAt: calibration.updatedAt,
          });
        });
      batches.push({
        id: batchId,
        code: batchCode,
        departDate: group.date,
        capacity: Math.max(group.rows.length, 1),
        agency: group.agency,
        state: '已出车',
        items,
        remark: '旧数据升级：按标定日期与机构自动切出的历史批次',
        createdAt: group.rows.reduce((min, row) => Math.min(min, row.calibration.createdAt), Date.now()),
        updatedAt: group.rows.reduce((max, row) => Math.max(max, row.calibration.updatedAt), 0),
      });
    });

  return { batches, dispatches, orphans };
}
