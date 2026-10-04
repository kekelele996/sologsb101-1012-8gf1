/**
 * 出车批次 slice（计量站侧）：维护出车批次、逐台结论与对账 / 退回动作。
 * 批次有名额，送检登记按 FIFO 排队进入筹备中的批次；已出车锁定不再加台。
 * 逐台结论按 台站码 + 序列号 与运维班送检登记对账，对上了才写回仪器（Calibration），
 * 对不上挂起等确认、不写结论；退回只退该台，其余照旧入库。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import type { Calibration } from '@/types/calibration';
import type { Instrument } from '@/types/instrument';
import type { Submission } from '@/types/submission';
import type {
  BatchItem,
  BatchItemStatus,
  BatchStatus,
  DispatchBatch,
} from '@/types/dispatch';
import {
  isConclusionFilled,
  makeBatchNo,
  planAssignments,
  reconcileItem,
} from '@/utils/reconcile';
import type { RootState } from '@/stores/store';

type WithDispatch = RootState;

export interface DispatchSliceState {
  batches: DispatchBatch[];
  items: BatchItem[];
  ready: boolean;
  error: string | null;
  /** 最近一次操作回执 */
  lastReceipt: string;
}

const initialState: DispatchSliceState = {
  batches: [],
  items: [],
  ready: false,
  error: null,
  lastReceipt: '',
};

/** 批次号：同日期已有批次序号顺延 */
async function nextBatchNo(date: string): Promise<string> {
  const all = await db.dispatchBatches.toArray();
  const sameDay = all.filter((row) => row.dispatchDate === date).length;
  return makeBatchNo(date, sameDay + 1);
}

/* ------------------------------ 批次 ------------------------------ */

export const createBatch = createAsyncThunk(
  'dispatch/createBatch',
  async (
    payload: Omit<DispatchBatch, 'id' | 'createdAt' | 'updatedAt' | 'batchNo' | 'status'> & {
      batchNo?: string;
    },
    { rejectWithValue }
  ) => {
    if (payload.capacity < 1) return rejectWithValue('能带台数至少为 1');
    const now = Date.now();
    const batchNo = payload.batchNo?.trim() || (await nextBatchNo(payload.dispatchDate));
    const row: DispatchBatch = {
      ...payload,
      batchNo,
      status: '筹备中',
      id: createId('bat'),
      createdAt: now,
      updatedAt: now,
    };
    await db.dispatchBatches.put(row);

    // 建批后立即按 FIFO 拉取待安排的送检登记（占满名额，其余排队等下一趟）
    const [submissions, items] = await Promise.all([
      db.submissions.toArray(),
      db.batchItems.toArray(),
    ]);
    const assignments = planAssignments(submissions, [row], items);
    await db.transaction('rw', [db.submissions, db.batchItems], async () => {
      for (const assignment of assignments) {
        const submission = submissions.find((s) => s.id === assignment.submissionId);
        if (!submission) continue;
        const item: BatchItem = {
          id: createId('bit'),
          batchId: row.id,
          stationCode: submission.stationCode,
          serialNo: submission.serialNo,
          instrumentId: submission.instrumentId,
          sensitivity: 0,
          selfNoise: 0,
          responseVerdict: '待判定',
          operator: '',
          reconStatus: '待对账',
          reconNote: '',
          calibrationId: null,
          returnedAt: null,
          remark: '',
          createdAt: now,
          updatedAt: now,
        };
        await db.batchItems.put(item);
        await db.submissions.update(submission.id, {
          status: '已安排',
          batchId: row.id,
          updatedAt: now,
        });
      }
    });

    return { batch: row, assigned: assignments.length };
  }
);

export const updateBatch = createAsyncThunk(
  'dispatch/updateBatch',
  async (payload: { id: string; patch: Partial<DispatchBatch> }, { rejectWithValue }) => {
    const existing = await db.dispatchBatches.get(payload.id);
    if (!existing) return rejectWithValue('批次不存在');
    if (existing.status !== '筹备中' && payload.patch.capacity !== undefined) {
      return rejectWithValue('已出车批次锁定，不能调整名额');
    }
    await db.dispatchBatches.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
    return payload;
  }
);

/** 出车：筹备中 → 已出车（锁定，不再加台） */
export const dispatchBatch = createAsyncThunk(
  'dispatch/dispatchBatch',
  async (batchId: string, { rejectWithValue }) => {
    const batch = await db.dispatchBatches.get(batchId);
    if (!batch) return rejectWithValue('批次不存在');
    if (batch.status !== '筹备中') return rejectWithValue(`批次已「${batch.status}」，不能重复出车`);
    const now = Date.now();
    await db.transaction('rw', [db.dispatchBatches, db.submissions], async () => {
      await db.dispatchBatches.update(batchId, { status: '已出车', updatedAt: now } as never);
      // 本批已安排的送检登记状态推进到已出车
      await db.submissions
        .where('batchId')
        .equals(batchId)
        .modify((row: Submission) => {
          if (row.status === '已安排') {
            row.status = '已出车';
            row.updatedAt = now;
          }
        });
    });
    return batchId;
  }
);

/** 完成：已出车 → 已完成 */
export const completeBatch = createAsyncThunk(
  'dispatch/completeBatch',
  async (batchId: string, { rejectWithValue }) => {
    const batch = await db.dispatchBatches.get(batchId);
    if (!batch) return rejectWithValue('批次不存在');
    if (batch.status !== '已出车') return rejectWithValue('只有已出车的批次才能完成');
    await db.dispatchBatches.update(batchId, { status: '已完成', updatedAt: Date.now() } as never);
    return batchId;
  }
);

/** 删除批次：连同明细；已安排的送检登记回退为待安排（不删送检登记） */
export const removeBatch = createAsyncThunk(
  'dispatch/removeBatch',
  async (batchId: string, { rejectWithValue }) => {
    const batch = await db.dispatchBatches.get(batchId);
    if (!batch) return rejectWithValue('批次不存在');
    if (batch.status === '已出车') return rejectWithValue('已出车批次不能删除（照旧不动）');
    const now = Date.now();
    await db.transaction('rw', [db.dispatchBatches, db.batchItems, db.submissions], async () => {
      await db.batchItems.where('batchId').equals(batchId).delete();
      await db.submissions
        .where('batchId')
        .equals(batchId)
        .modify((row: Submission) => {
          if (row.status === '已安排') {
            row.status = '待安排';
            row.batchId = null;
            row.updatedAt = now;
          }
        });
      await db.dispatchBatches.delete(batchId);
    });
    return batchId;
  }
);

/* ------------------------------ 逐台结论 ------------------------------ */

/** 手工追加逐台明细（计量站收到的散台：只记台站码+序列号，对账不过就挂起） */
export const addBatchItem = createAsyncThunk(
  'dispatch/addBatchItem',
  async (
    payload: { batchId: string; stationCode: string; serialNo: string; remark?: string },
    { rejectWithValue }
  ) => {
    const batch = await db.dispatchBatches.get(payload.batchId);
    if (!batch) return rejectWithValue('批次不存在');
    if (batch.status !== '筹备中') return rejectWithValue('已出车批次锁定，不能加台');
    const stationCode = payload.stationCode.trim();
    const serialNo = payload.serialNo.trim();
    if (!stationCode || !serialNo) return rejectWithValue('请填写台站码和序列号');
    const now = Date.now();
    const item: BatchItem = {
      id: createId('bit'),
      batchId: payload.batchId,
      stationCode,
      serialNo,
      instrumentId: null,
      sensitivity: 0,
      selfNoise: 0,
      responseVerdict: '待判定',
      operator: '',
      reconStatus: '待对账',
      reconNote: '',
      calibrationId: null,
      returnedAt: null,
      remark: payload.remark?.trim() ?? '',
      createdAt: now,
      updatedAt: now,
    };
    await db.batchItems.put(item);
    return item;
  }
);

/** 保存逐台结论（灵敏度 / 自噪 / 结论），保存后立即尝试对账 */
export const saveItemConclusion = createAsyncThunk(
  'dispatch/saveItemConclusion',
  async (
    payload: {
      itemId: string;
      patch: Partial<Pick<BatchItem, 'sensitivity' | 'selfNoise' | 'responseVerdict' | 'operator' | 'remark'>>;
    },
    { rejectWithValue, dispatch }
  ) => {
    const item = await db.batchItems.get(payload.itemId);
    if (!item) return rejectWithValue('明细不存在');
    if (item.reconStatus === '已退回') return rejectWithValue('该台已退回，不能录入结论');
    const now = Date.now();
    await db.batchItems.update(payload.itemId, { ...payload.patch, updatedAt: now } as never);
    // 结论录入后立即对账（对上写结论，对不上挂起）
    await dispatch(reconcileItems({ itemIds: [payload.itemId] }));
    return payload.itemId;
  }
);

/** 退回某台：只退这一台，其余照旧入库 */
export const returnItem = createAsyncThunk(
  'dispatch/returnItem',
  async (payload: { itemId: string; reason: string }, { rejectWithValue }) => {
    const item = await db.batchItems.get(payload.itemId);
    if (!item) return rejectWithValue('明细不存在');
    if (item.reconStatus === '已对账') return rejectWithValue('该台已对账出结论，不能退回');
    const now = Date.now();
    await db.transaction('rw', [db.batchItems, db.submissions], async () => {
      await db.batchItems.update(payload.itemId, {
        reconStatus: '已退回',
        reconNote: payload.reason.trim() || '计量站退回',
        returnedAt: now,
        updatedAt: now,
      } as never);
      // 关联的送检登记同步置为已退回（只影响这一台）
      const sub = await db.submissions
        .filter(
          (row) =>
            row.stationCode.trim() === item.stationCode.trim() &&
            row.serialNo.trim() === item.serialNo.trim()
        )
        .first();
      if (sub && sub.status !== '已对账') {
        await db.submissions.update(sub.id, {
          status: '已退回',
          reconNote: payload.reason.trim() || '计量站退回',
          updatedAt: now,
        });
      }
    });
    return payload.itemId;
  }
);

/* ------------------------------ 对账 ------------------------------ */

/**
 * 对账：对指定明细（或全部待对账/对账失败明细）按 台站码+序列号 与运维班送检登记匹配。
 * 对上了写回仪器结论（Calibration），对不上挂起不写结论。
 * 运维班补登记后可再次调用本动作重试（按运维班这侧重试）。
 */
export const reconcileItems = createAsyncThunk(
  'dispatch/reconcileItems',
  async (payload: { itemIds?: string[] } = {}) => {
    const [allItems, submissions, instruments, batches] = await Promise.all([
      db.batchItems.toArray(),
      db.submissions.toArray(),
      db.instruments.toArray(),
      db.dispatchBatches.toArray(),
    ]);
    const batchMap = new Map(batches.map((b) => [b.id, b]));

    const targets = allItems.filter((item) => {
      if (payload.itemIds && !payload.itemIds.includes(item.id)) return false;
      if (item.reconStatus === '已退回' || item.reconStatus === '已对账') return false;
      // 结论未录入的不对账（仍停在待对账）
      return isConclusionFilled(item);
    });

    const now = Date.now();
    let written = 0;
    let reconciled = 0;
    let failed = 0;

    await db.transaction('rw', [db.batchItems, db.submissions, db.calibrations], async () => {
      for (const item of targets) {
        const outcome = reconcileItem(item, submissions, instruments);
        const batch = batchMap.get(item.batchId);

        if (outcome.ok && outcome.instrument) {
          reconciled += 1;
          let calibrationId = item.calibrationId;
          if (outcome.shouldWriteCalibration) {
            const calibration: Calibration = {
              id: createId('cal'),
              instrumentId: outcome.instrument.id,
              date: batch?.dispatchDate ?? new Date(now).toISOString().slice(0, 10),
              sensitivity: item.sensitivity,
              selfNoise: item.selfNoise,
              responseVerdict: item.responseVerdict,
              operator: item.operator || batch?.agency || '计量站',
              agency: batch?.agency ?? '',
              remark: item.remark,
              createdAt: now,
              updatedAt: now,
            };
            await db.calibrations.put(calibration);
            calibrationId = calibration.id;
            written += 1;
          } else if (!calibrationId) {
            // 复用已有结论：挂到该仪器最近一次标定上
            const existing = await db.calibrations
              .where('instrumentId')
              .equals(outcome.instrument.id)
              .sortBy('date');
            calibrationId = existing[existing.length - 1]?.id ?? null;
          }
          await db.batchItems.update(item.id, {
            reconStatus: '已对账',
            instrumentId: outcome.instrument.id,
            calibrationId,
            reconNote: '',
            updatedAt: now,
          } as never);
          if (outcome.submission && outcome.submission.status !== '已对账') {
            await db.submissions.update(outcome.submission.id, {
              status: '已对账',
              reconNote: '',
              updatedAt: now,
            });
          }
        } else {
          failed += 1;
          await db.batchItems.update(item.id, {
            reconStatus: '对账失败',
            reconNote: outcome.reason,
            instrumentId: outcome.instrument?.id ?? null,
            updatedAt: now,
          } as never);
          if (outcome.submission) {
            await db.submissions.update(outcome.submission.id, {
              status: '对账失败',
              reconNote: outcome.reason,
              updatedAt: now,
            });
          }
        }
      }
    });

    return { reconciled, failed, written, total: targets.length };
  }
);

const dispatchSlice = createSlice({
  name: 'dispatch',
  initialState,
  reducers: {
    setBatches(state, action: PayloadAction<DispatchBatch[]>) {
      state.batches = action.payload;
      state.ready = true;
      state.error = null;
    },
    setBatchItems(state, action: PayloadAction<BatchItem[]>) {
      state.items = action.payload;
    },
    setDispatchError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setDispatchReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createBatch.fulfilled, (state, action) => {
        state.lastReceipt = `批次 ${action.payload.batch.batchNo} 已建，拉入 ${action.payload.assigned} 台送检仪器，其余排队等下一趟`;
      })
      .addCase(createBatch.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '批次创建失败';
      })
      .addCase(dispatchBatch.fulfilled, () => {
        // 回执在组件层按批次号补充
      })
      .addCase(dispatchBatch.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '出车失败';
      })
      .addCase(reconcileItems.fulfilled, (state, action) => {
        state.lastReceipt = `对账完成：${action.payload.reconciled} 台对上（新写结论 ${action.payload.written} 条），${action.payload.failed} 台挂起待确认`;
      })
      .addCase(saveItemConclusion.fulfilled, () => {
        // 对账结果由 reconcileItems 回执
      })
      .addCase(returnItem.fulfilled, (state) => {
        state.lastReceipt = '该台已退回，其余仪器照旧入库';
      })
      .addCase(returnItem.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '退回失败';
      })
      .addCase(removeBatch.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '批次删除失败';
      });
  },
});

export const { setBatches, setBatchItems, setDispatchError, setDispatchReceipt } =
  dispatchSlice.actions;

let started = false;

/** 启动出车批次与明细表实时订阅（幂等） */
export function startDispatchSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<DispatchBatch>(() => db.dispatchBatches).subscribe((rows) => {
    dispatch(setBatches(rows));
  });
  watchTable<BatchItem>(() => db.batchItems).subscribe((rows) => {
    dispatch(setBatchItems(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectDispatchState = (state: WithDispatch): DispatchSliceState => state.dispatch;
export const selectBatches = (state: WithDispatch): DispatchBatch[] => state.dispatch.batches;
export const selectBatchItems = (state: WithDispatch): BatchItem[] => state.dispatch.items;
export const selectDispatchReady = (state: WithDispatch): boolean => state.dispatch.ready;
export const selectDispatchReceipt = (state: WithDispatch): string => state.dispatch.lastReceipt;

export const selectBatchById = (
  state: WithDispatch,
  id: string | null | undefined
): DispatchBatch | null =>
  id ? state.dispatch.batches.find((row) => row.id === id) ?? null : null;

export const selectItemsOfBatch = (
  state: WithDispatch,
  batchId: string | null | undefined
): BatchItem[] => {
  if (!batchId) return [];
  return state.dispatch.items
    .filter((row) => row.batchId === batchId)
    .sort((a, b) => a.createdAt - b.createdAt);
};

/** 明细按 id 索引 */
export const selectItemMap = (state: WithDispatch): Record<string, BatchItem> => {
  const map: Record<string, BatchItem> = {};
  state.dispatch.items.forEach((item) => {
    map[item.id] = item;
  });
  return map;
};

/** 各批次名额占用与对账进度 */
export interface BatchStats {
  used: number;
  reconciled: number;
  failed: number;
  returned: number;
  pending: number;
}

export const selectBatchStats = (state: WithDispatch): Record<string, BatchStats> => {
  const result: Record<string, BatchStats> = {};
  state.dispatch.batches.forEach((batch) => {
    const items = state.dispatch.items.filter((row) => row.batchId === batch.id);
    result[batch.id] = {
      used: items.filter((row) => row.reconStatus !== '已退回').length,
      reconciled: items.filter((row) => row.reconStatus === '已对账').length,
      failed: items.filter((row) => row.reconStatus === '对账失败').length,
      returned: items.filter((row) => row.reconStatus === '已退回').length,
      pending: items.filter((row) => row.reconStatus === '待对账').length,
    };
  });
  return result;
};

export type { BatchStatus };

export default dispatchSlice.reducer;
