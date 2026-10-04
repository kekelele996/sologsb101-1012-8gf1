/**
 * 送检登记 slice（运维班侧）：按台站登记仪器送检，状态随派单 / 出车 / 对账 / 退回流转。
 * 登记后立即按 FIFO 派入筹备中批次（满了排队等下一趟），并触发一次对账重试——
 * 这样运维班补登记后，之前挂起的计量站明细会自动对上（按运维班这侧重试）。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import type { Instrument } from '@/types/instrument';
import type { Submission, SubmissionDraft, SubmissionStatus } from '@/types/submission';
import { createEmptySubmissionDraft } from '@/types/submission';
import { planAssignments } from '@/utils/reconcile';
import { reconcileItems } from '@/stores/dispatchSlice';
import type { RootState } from '@/stores/store';

type WithSubmission = RootState;

export interface SubmissionSliceState {
  submissions: Submission[];
  ready: boolean;
  error: string | null;
  draft: SubmissionDraft;
  lastReceipt: string;
}

const initialState: SubmissionSliceState = {
  submissions: [],
  ready: false,
  error: null,
  draft: createEmptySubmissionDraft(),
  lastReceipt: '',
};

/** 送检登记：必须关联运维台账中的仪器（带出台站码 + 序列号） */
export const createSubmission = createAsyncThunk(
  'submission/createSubmission',
  async (
    payload: { instrumentId: string; submittedDate: string; remark?: string },
    { rejectWithValue, dispatch }
  ) => {
    const instrument = await db.instruments.get(payload.instrumentId);
    if (!instrument) return rejectWithValue('请选择要送检的仪器');
    if (instrument.state === '已停用') {
      return rejectWithValue(`仪器 ${instrument.serialNo} 已停用，不能送检`);
    }
    // 同一台仪器有未闭环的送检登记时不重复登记
    const existing = await db.submissions
      .where('instrumentId')
      .equals(payload.instrumentId)
      .filter((row) => row.status !== '已对账' && row.status !== '已退回')
      .first();
    if (existing) {
      return rejectWithValue(
        `仪器 ${instrument.serialNo} 已有送检登记（${existing.status}），批次 ${existing.batchId ?? '排队中'}`
      );
    }

    const now = Date.now();
    const row: Submission = {
      id: createId('sub'),
      instrumentId: instrument.id,
      stationId: instrument.stationId,
      stationCode: '', // 下方补台站码
      serialNo: instrument.serialNo,
      submittedDate: payload.submittedDate,
      status: '待安排',
      batchId: null,
      reconNote: '',
      remark: payload.remark?.trim() ?? '',
      createdAt: now,
      updatedAt: now,
    };

    // 补台站码
    const station = await db.stations.get(instrument.stationId);
    row.stationCode = station?.code ?? '';

    await db.submissions.put(row);

    // 立即按 FIFO 派入筹备中批次（满了排队等下一趟，已出车的不动）
    const [batches, items] = await Promise.all([db.dispatchBatches.toArray(), db.batchItems.toArray()]);
    const assignments = planAssignments([row], batches, items);
    let assignedBatchId: string | null = null;
    if (assignments.length > 0) {
      const assignment = assignments[0];
      assignedBatchId = assignment.batchId;
      const batch = batches.find((b) => b.id === assignment.batchId);
      await db.transaction('rw', [db.submissions, db.batchItems], async () => {
        await db.submissions.update(row.id, {
          status: '已安排',
          batchId: assignment.batchId,
          updatedAt: now,
        });
        await db.batchItems.put({
          id: createId('bit'),
          batchId: assignment.batchId,
          stationCode: row.stationCode,
          serialNo: row.serialNo,
          instrumentId: instrument.id,
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
        });
      });
      void batch;
    }

    // 登记后触发一次对账重试：之前挂起的计量站明细可能因这条补登记而对上
    const reconResult = await dispatch(reconcileItems({})).unwrap();

    return {
      row,
      assigned: assignedBatchId !== null,
      reconResult,
    };
  }
);

export const updateSubmission = createAsyncThunk(
  'submission/updateSubmission',
  async (payload: { id: string; patch: Partial<Submission> }, { rejectWithValue }) => {
    const existing = await db.submissions.get(payload.id);
    if (!existing) return rejectWithValue('送检登记不存在');
    await db.submissions.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
    return payload;
  }
);

/** 删除送检登记：已派车 / 已对账的不允许（照旧不动） */
export const removeSubmission = createAsyncThunk(
  'submission/removeSubmission',
  async (id: string, { rejectWithValue }) => {
    const existing = await db.submissions.get(id);
    if (!existing) return rejectWithValue('送检登记不存在');
    if (existing.status === '已出车' || existing.status === '已对账') {
      return rejectWithValue(`送检登记已「${existing.status}」，不能删除`);
    }
    const now = Date.now();
    await db.transaction('rw', [db.submissions, db.batchItems], async () => {
      if (existing.batchId) {
        // 删掉对应批次明细（仅待对账 / 对账失败的），释放名额
        await db.batchItems
          .where('batchId')
          .equals(existing.batchId)
          .filter(
            (item) =>
              item.stationCode === existing.stationCode &&
              item.serialNo === existing.serialNo &&
              (item.reconStatus === '待对账' || item.reconStatus === '对账失败')
          )
          .delete();
      }
      await db.submissions.delete(id);
    });
    void now;
    return id;
  }
);

const submissionSlice = createSlice({
  name: 'submission',
  initialState,
  reducers: {
    setSubmissions(state, action: PayloadAction<Submission[]>) {
      state.submissions = action.payload;
      state.ready = true;
      state.error = null;
    },
    setSubmissionError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    patchSubmissionDraft(state, action: PayloadAction<Partial<SubmissionDraft>>) {
      state.draft = { ...state.draft, ...action.payload };
    },
    resetSubmissionDraft(state) {
      state.draft = createEmptySubmissionDraft();
    },
    setSubmissionReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createSubmission.fulfilled, (state, action) => {
        const queueText = action.payload.assigned ? '已派入筹备中批次' : '批次名额已满，排队等下一趟';
        const recon = action.payload.reconResult;
        const reconText =
          recon.failed > 0
            ? `；对账重试：${recon.reconciled} 台对上，${recon.failed} 台仍挂起`
            : recon.reconciled > 0
              ? `；对账重试：${recon.reconciled} 台已对上`
              : '';
        state.lastReceipt = `送检登记已提交（${queueText}）${reconText}`;
      })
      .addCase(createSubmission.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '送检登记失败';
      })
      .addCase(removeSubmission.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '送检登记删除失败';
      });
  },
});

export const {
  setSubmissions,
  setSubmissionError,
  patchSubmissionDraft,
  resetSubmissionDraft,
  setSubmissionReceipt,
} = submissionSlice.actions;

let started = false;

/** 启动送检登记表实时订阅（幂等） */
export function startSubmissionSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<Submission>(() => db.submissions).subscribe((rows) => {
    dispatch(setSubmissions(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectSubmissionState = (state: WithSubmission): SubmissionSliceState =>
  state.submission;
export const selectSubmissions = (state: WithSubmission): Submission[] =>
  state.submission.submissions;
export const selectSubmissionReady = (state: WithSubmission): boolean => state.submission.ready;
export const selectSubmissionDraft = (state: WithSubmission): SubmissionDraft =>
  state.submission.draft;
export const selectSubmissionReceipt = (state: WithSubmission): string =>
  state.submission.lastReceipt;

/** 按仪器 id 查送检登记 */
export const selectSubmissionByInstrument = (
  state: WithSubmission,
  instrumentId: string | null | undefined
): Submission | null =>
  instrumentId
    ? state.submission.submissions.find((row) => row.instrumentId === instrumentId) ?? null
    : null;

/** 按台站码 + 序列号查送检登记 */
export const selectSubmissionByKey = (
  state: WithSubmission,
  stationCode: string,
  serialNo: string
): Submission | null =>
  state.submission.submissions.find(
    (row) => row.stationCode === stationCode && row.serialNo === serialNo
  ) ?? null;

/** 各状态计数 */
export const selectSubmissionStatusCounts = (
  state: WithSubmission
): Record<SubmissionStatus, number> => {
  const counts: Record<SubmissionStatus, number> = {
    待安排: 0,
    已安排: 0,
    已出车: 0,
    已对账: 0,
    对账失败: 0,
    已退回: 0,
  };
  state.submission.submissions.forEach((row) => {
    counts[row.status] += 1;
  });
  return counts;
};

export type { Instrument };

export default submissionSlice.reducer;
