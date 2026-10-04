/**
 * 台阵 slice：维护台阵与台站列表、当前选中台阵与筛选条件。
 * 数据经 utils/db.ts 的 Dexie liveQuery 订阅后写入 store；页面只读 selector，写操作落 IndexedDB。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, readLastArrayId, watchTable, writeLastArrayId } from '@/utils/db';
import type { SeisArray, ArrayFilterState } from '@/types/array';
import { createEmptyArrayFilter } from '@/types/array';
import type { SeisStation, StationFilterState } from '@/types/station';
import { createEmptyStationFilter } from '@/types/station';
import { apertureKm } from '@/utils/geo';
import type { RootState } from '@/stores/store';

/** 选择器入参统一用 RootState，避免本地结构类型重复定义 */
type WithArray = RootState;

export interface ArraySliceState {
  arrays: SeisArray[];
  stations: SeisStation[];
  ready: boolean;
  error: string | null;
  currentArrayId: string | null;
  filter: ArrayFilterState;
  stationFilter: StationFilterState;
}

const initialState: ArraySliceState = {
  arrays: [],
  stations: [],
  ready: false,
  error: null,
  currentArrayId: readLastArrayId(),
  filter: createEmptyArrayFilter(),
  stationFilter: createEmptyStationFilter(),
};

/* ------------------------------ 异步动作（落库后由 liveQuery 回流） ------------------------------ */

export const createArray = createAsyncThunk(
  'array/createArray',
  async (payload: Omit<SeisArray, 'id' | 'createdAt' | 'updatedAt' | 'stationCount'>) => {
    const now = Date.now();
    const row: SeisArray = {
      ...payload,
      stationCount: 0,
      id: createId('arr'),
      createdAt: now,
      updatedAt: now,
    };
    await db.arrays.put(row);
    return row;
  }
);

export const updateArray = createAsyncThunk(
  'array/updateArray',
  async (payload: { id: string; patch: Partial<SeisArray> }) => {
    await db.arrays.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
    return payload;
  }
);

/** 删除台阵：级联删除台站、仪器、标定与更换记录 */
export const removeArray = createAsyncThunk('array/removeArray', async (arrayId: string) => {
  await db.transaction(
    'rw',
    [db.arrays, db.stations, db.instruments, db.calibrations, db.replaces],
    async () => {
      const stationIds = (await db.stations.where('arrayId').equals(arrayId).toArray()).map(
        (row) => row.id
      );
      if (stationIds.length > 0) {
        const instrumentIds = (
          await db.instruments.where('stationId').anyOf(stationIds).toArray()
        ).map((row) => row.id);
        if (instrumentIds.length > 0) {
          await db.calibrations.where('instrumentId').anyOf(instrumentIds).delete();
          await db.replaces.where('instrumentId').anyOf(instrumentIds).delete();
          await db.instruments.bulkDelete(instrumentIds);
        }
        await db.stations.bulkDelete(stationIds);
      }
      await db.arrays.delete(arrayId);
    }
  );
  return arrayId;
});

export const createStation = createAsyncThunk(
  'array/createStation',
  async (payload: Omit<SeisStation, 'id' | 'createdAt' | 'updatedAt'>) => {
    const now = Date.now();
    const row: SeisStation = { ...payload, id: createId('stn'), createdAt: now, updatedAt: now };
    await db.stations.put(row);
    return row;
  }
);

export const updateStation = createAsyncThunk(
  'array/updateStation',
  async (payload: { id: string; patch: Partial<SeisStation> }) => {
    await db.stations.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
    return payload;
  }
);

/** 删除台站：级联删除仪器、标定与更换记录 */
export const removeStation = createAsyncThunk('array/removeStation', async (stationId: string) => {
  await db.transaction('rw', [db.stations, db.instruments, db.calibrations, db.replaces], async () => {
    const instrumentIds = (
      await db.instruments.where('stationId').equals(stationId).toArray()
    ).map((row) => row.id);
    if (instrumentIds.length > 0) {
      await db.calibrations.where('instrumentId').anyOf(instrumentIds).delete();
      await db.replaces.where('instrumentId').anyOf(instrumentIds).delete();
      await db.instruments.bulkDelete(instrumentIds);
    }
    await db.stations.delete(stationId);
  });
  return stationId;
});

/** 按经纬度重算台阵孔径并回写台阵表 */
export const recomputeAperture = createAsyncThunk(
  'array/recomputeAperture',
  async (arrayId: string) => {
    const stations = await db.stations.where('arrayId').equals(arrayId).toArray();
    const computed = apertureKm(
      stations.map((station) => ({
        id: station.id,
        code: station.code,
        lat: station.lat,
        lng: station.lng,
      }))
    );
    await db.arrays.update(arrayId, { apertureKm: computed, updatedAt: Date.now() } as never);
    return { arrayId, apertureKm: computed };
  }
);

/** 同步台站数到台阵表 */
export const syncStationCount = createAsyncThunk(
  'array/syncStationCount',
  async (arrayId: string) => {
    const count = await db.stations.where('arrayId').equals(arrayId).count();
    const array = await db.arrays.get(arrayId);
    if (array && array.stationCount !== count) {
      await db.arrays.update(arrayId, { stationCount: count, updatedAt: Date.now() } as never);
    }
    return { arrayId, stationCount: count };
  }
);

const arraySlice = createSlice({
  name: 'array',
  initialState,
  reducers: {
    /** 由 liveQuery 推送整表数据 */
    setArrays(state, action: PayloadAction<SeisArray[]>) {
      state.arrays = action.payload;
      state.ready = true;
      state.error = null;
      if (state.currentArrayId === null && action.payload.length > 0) {
        state.currentArrayId = action.payload[0].id;
      }
    },
    setStations(state, action: PayloadAction<SeisStation[]>) {
      state.stations = action.payload;
    },
    setError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    selectArray(state, action: PayloadAction<string | null>) {
      state.currentArrayId = action.payload;
      writeLastArrayId(action.payload);
    },
    patchFilter(state, action: PayloadAction<Partial<ArrayFilterState>>) {
      state.filter = { ...state.filter, ...action.payload };
    },
    resetFilter(state) {
      state.filter = createEmptyArrayFilter();
    },
    patchStationFilter(state, action: PayloadAction<Partial<StationFilterState>>) {
      state.stationFilter = { ...state.stationFilter, ...action.payload };
    },
    resetStationFilter(state) {
      state.stationFilter = createEmptyStationFilter();
    },
  },
});

export const {
  setArrays,
  setStations,
  setError,
  selectArray,
  patchFilter,
  resetFilter,
  patchStationFilter,
  resetStationFilter,
} = arraySlice.actions;

/* ------------------------------ 模块级订阅启动 ------------------------------ */

let started = false;

/** 启动 IndexedDB 实时订阅（幂等）：在应用挂载时调用一次 */
export function startArraySubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<SeisArray>(() => db.arrays).subscribe((rows) => {
    dispatch(setArrays(rows));
  });
  watchTable<SeisStation>(() => db.stations).subscribe((rows) => {
    dispatch(setStations(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectArrayState = (state: WithArray): ArraySliceState => state.array;
export const selectArrays = (state: WithArray): SeisArray[] => state.array.arrays;
export const selectStations = (state: WithArray): SeisStation[] => state.array.stations;
export const selectArrayReady = (state: WithArray): boolean => state.array.ready;
export const selectCurrentArrayId = (state: WithArray): string | null => state.array.currentArrayId;
export const selectArrayFilter = (state: WithArray): ArrayFilterState => state.array.filter;
export const selectStationFilter = (state: WithArray): StationFilterState => state.array.stationFilter;

export const selectArrayById = (state: WithArray, id: string | null | undefined): SeisArray | null =>
  id ? state.array.arrays.find((row) => row.id === id) ?? null : null;

export const selectStationsOfArray = (state: WithArray, arrayId: string | null | undefined): SeisStation[] => {
  if (!arrayId) return [];
  return state.array.stations
    .filter((row) => row.arrayId === arrayId)
    .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'));
};

export const selectStationById = (state: WithArray, id: string | null | undefined): SeisStation | null =>
  id ? state.array.stations.find((row) => row.id === id) ?? null : null;

export default arraySlice.reducer;
