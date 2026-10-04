/**
 * 标定 slice：维护标定记录、筛选条件与灵敏度派生值；
 * 同时维护更换记录（合格评定与更换提醒同属标定成果的下游动作）。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import type {
  Calibration,
  CalibrationFilterState,
  ResponseVerdict,
} from '@/types/calibration';
import { createEmptyCalibrationFilter, judgeCalibration, sensitivityDelta } from '@/types/calibration';
import type { Replace, ReplaceFilterState, ReplaceState } from '@/types/replace';
import { canTransition, createEmptyReplaceFilter } from '@/types/replace';
import type { Instrument } from '@/types/instrument';
import type { RootState } from '@/stores/store';

/** 选择器入参统一用 RootState */
type WithCalibration = RootState;

export interface CalibrationSliceState {
  calibrations: Calibration[];
  replaces: Replace[];
  instruments: Instrument[];
  ready: boolean;
  error: string | null;
  filter: CalibrationFilterState;
  replaceFilter: ReplaceFilterState;
  /** 最近一次操作回执 */
  lastReceipt: string;
}

const initialState: CalibrationSliceState = {
  calibrations: [],
  replaces: [],
  instruments: [],
  ready: false,
  error: null,
  filter: createEmptyCalibrationFilter(),
  replaceFilter: createEmptyReplaceFilter(),
  lastReceipt: '',
};

export const createCalibration = createAsyncThunk(
  'calibration/createCalibration',
  async (payload: Omit<Calibration, 'id' | 'createdAt' | 'updatedAt' | 'responseVerdict'>) => {
    const now = Date.now();
    const instrument = await db.instruments.get(payload.instrumentId);
    const verdict = judgeCalibration(
      instrument?.type ?? '宽频带',
      payload.sensitivity,
      payload.selfNoise
    );
    const row: Calibration = {
      ...payload,
      responseVerdict: verdict,
      id: createId('cal'),
      createdAt: now,
      updatedAt: now,
    };
    await db.calibrations.put(row);
    // 标定完成后按结论回写仪器状态
    if (instrument) {
      await db.instruments.update(instrument.id, {
        state: verdict === '不合格' ? '待标定' : '在用',
        updatedAt: now,
      } as never);
    }
    return row;
  }
);

export const updateCalibration = createAsyncThunk(
  'calibration/updateCalibration',
  async (payload: { id: string; patch: Partial<Calibration> }) => {
    const existing = await db.calibrations.get(payload.id);
    const instrument = existing ? await db.instruments.get(existing.instrumentId) : undefined;
    const nextSensitivity = payload.patch.sensitivity ?? existing?.sensitivity ?? 0;
    const nextNoise = payload.patch.selfNoise ?? existing?.selfNoise ?? 0;
    const verdict = judgeCalibration(instrument?.type ?? '宽频带', nextSensitivity, nextNoise);
    await db.calibrations.update(payload.id, {
      ...payload.patch,
      responseVerdict: payload.patch.responseVerdict ?? verdict,
      updatedAt: Date.now(),
    } as never);
    return payload;
  }
);

export const removeCalibration = createAsyncThunk(
  'calibration/removeCalibration',
  async (calibrationId: string) => {
    await db.calibrations.delete(calibrationId);
    return calibrationId;
  }
);

/** 批量改响应结论（标定记录台的批量操作） */
export const bulkSetVerdict = createAsyncThunk(
  'calibration/bulkSetVerdict',
  async (payload: { ids: string[]; verdict: ResponseVerdict }) => {
    const now = Date.now();
    await db.calibrations
      .where('id')
      .anyOf(payload.ids)
      .modify((row) => {
        row.responseVerdict = payload.verdict;
        row.updatedAt = now;
      });
    return payload;
  }
);

/* ------------------------------ 更换记录 ------------------------------ */

export const createReplace = createAsyncThunk(
  'calibration/createReplace',
  async (payload: Omit<Replace, 'id' | 'createdAt' | 'updatedAt'>) => {
    const now = Date.now();
    const row: Replace = { ...payload, id: createId('rpl'), createdAt: now, updatedAt: now };
    await db.replaces.put(row);
    return row;
  }
);

export const updateReplace = createAsyncThunk(
  'calibration/updateReplace',
  async (payload: { id: string; patch: Partial<Replace> }) => {
    await db.replaces.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
    return payload;
  }
);

/**
 * 推进更换状态机：
 * 流转到「已更换」时回写仪器序列号并置为在用（更换完成后回写仪器序列号并归档旧记录）。
 */
export const transitionReplace = createAsyncThunk(
  'calibration/transitionReplace',
  async (
    payload: { id: string; next: ReplaceState },
    { rejectWithValue }
  ) => {
    const replace = await db.replaces.get(payload.id);
    if (!replace) return rejectWithValue('更换记录不存在');
    if (!canTransition(replace.state, payload.next)) {
      return rejectWithValue(`状态机不允许从「${replace.state}」流转到「${payload.next}」`);
    }
    const now = Date.now();
    await db.transaction('rw', [db.replaces, db.instruments], async () => {
      await db.replaces.update(payload.id, { state: payload.next, updatedAt: now } as never);
      if (payload.next === '已更换' && replace.newSerialNo) {
        await db.instruments.update(replace.instrumentId, {
          serialNo: replace.newSerialNo,
          state: '在用',
          updatedAt: now,
        } as never);
      }
    });
    return payload;
  }
);

export const removeReplace = createAsyncThunk('calibration/removeReplace', async (id: string) => {
  await db.replaces.delete(id);
  return id;
});

const calibrationSlice = createSlice({
  name: 'calibration',
  initialState,
  reducers: {
    setCalibrations(state, action: PayloadAction<Calibration[]>) {
      state.calibrations = action.payload;
      state.ready = true;
      state.error = null;
    },
    setReplaces(state, action: PayloadAction<Replace[]>) {
      state.replaces = action.payload;
    },
    setInstrumentsForCalibration(state, action: PayloadAction<Instrument[]>) {
      state.instruments = action.payload;
    },
    patchFilter(state, action: PayloadAction<Partial<CalibrationFilterState>>) {
      state.filter = { ...state.filter, ...action.payload };
    },
    resetFilter(state) {
      state.filter = createEmptyCalibrationFilter();
    },
    patchReplaceFilter(state, action: PayloadAction<Partial<ReplaceFilterState>>) {
      state.replaceFilter = { ...state.replaceFilter, ...action.payload };
    },
    resetReplaceFilter(state) {
      state.replaceFilter = createEmptyReplaceFilter();
    },
    setCalibrationError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setCalibrationReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createCalibration.fulfilled, (state, action) => {
        state.lastReceipt = `标定记录已保存，响应结论自动初判为「${action.payload.responseVerdict}」`;
      })
      .addCase(bulkSetVerdict.fulfilled, (state, action) => {
        state.lastReceipt = `已批量将 ${action.payload.ids.length} 条标定记录的响应结论改为「${action.payload.verdict}」`;
      })
      .addCase(transitionReplace.fulfilled, (state, action) => {
        state.lastReceipt =
          action.payload.next === '已更换'
            ? '更换完成：已回写仪器序列号并置为在用，旧记录已归档'
            : `更换记录状态已流转到「${action.payload.next}」`;
      })
      .addCase(transitionReplace.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '更换状态流转失败';
      });
  },
});

export const {
  setCalibrations,
  setReplaces,
  setInstrumentsForCalibration,
  patchFilter,
  resetFilter,
  patchReplaceFilter,
  resetReplaceFilter,
  setCalibrationError,
  setCalibrationReceipt,
} = calibrationSlice.actions;

let started = false;

/** 启动标定 / 更换 / 仪器表实时订阅（幂等） */
export function startCalibrationSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<Calibration>(() => db.calibrations).subscribe((rows) => {
    dispatch(setCalibrations(rows));
  });
  watchTable<Replace>(() => db.replaces).subscribe((rows) => {
    dispatch(setReplaces(rows));
  });
  watchTable<Instrument>(() => db.instruments).subscribe((rows) => {
    dispatch(setInstrumentsForCalibration(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectCalibrationState = (state: WithCalibration): CalibrationSliceState =>
  state.calibration;
export const selectCalibrations = (state: WithCalibration): Calibration[] =>
  state.calibration.calibrations;
export const selectReplaces = (state: WithCalibration): Replace[] => state.calibration.replaces;
export const selectCalibrationReady = (state: WithCalibration): boolean => state.calibration.ready;
export const selectCalibrationFilter = (state: WithCalibration): CalibrationFilterState =>
  state.calibration.filter;
export const selectReplaceFilter = (state: WithCalibration): ReplaceFilterState =>
  state.calibration.replaceFilter;
export const selectCalibrationReceipt = (state: WithCalibration): string =>
  state.calibration.lastReceipt;

export const selectCalibrationsOfInstrument = (
  state: WithCalibration,
  instrumentId: string | null | undefined
): Calibration[] => {
  if (!instrumentId) return [];
  return state.calibration.calibrations
    .filter((row) => row.instrumentId === instrumentId)
    .sort((a, b) => b.date.localeCompare(a.date));
};

export const selectReplacesOfInstrument = (
  state: WithCalibration,
  instrumentId: string | null | undefined
): Replace[] => {
  if (!instrumentId) return [];
  return state.calibration.replaces.filter((row) => row.instrumentId === instrumentId);
};

/** 标定 id → 灵敏度变化（相对同仪器上一次标定） */
export const selectSensitivityDeltas = (
  state: WithCalibration
): Record<string, ReturnType<typeof sensitivityDelta>> => {
  const result: Record<string, ReturnType<typeof sensitivityDelta>> = {};
  const grouped = new Map<string, Calibration[]>();
  state.calibration.calibrations.forEach((row) => {
    const list = grouped.get(row.instrumentId) ?? [];
    list.push(row);
    grouped.set(row.instrumentId, list);
  });
  grouped.forEach((list) => {
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    sorted.forEach((row, index) => {
      const previous = index > 0 ? sorted[index - 1].sensitivity : null;
      result[row.id] = sensitivityDelta(row.sensitivity, previous);
    });
  });
  return result;
};

export default calibrationSlice.reducer;
