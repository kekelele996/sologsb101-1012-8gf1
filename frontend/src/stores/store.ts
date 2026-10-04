/**
 * Redux store：汇总台阵 / 仪器 / 标定三个 slice。
 * 跨页状态全部放在 slice 中，组件只读 selector 并 dispatch 异步动作落 IndexedDB。
 */
import { configureStore } from '@reduxjs/toolkit';
import { useDispatch, useSelector, type TypedUseSelectorHook } from 'react-redux';
import arrayReducer from '@/stores/arraySlice';
import instrumentReducer from '@/stores/instrumentSlice';
import calibrationReducer from '@/stores/calibrationSlice';

export const store = configureStore({
  reducer: {
    array: arrayReducer,
    instrument: instrumentReducer,
    calibration: calibrationReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      // IndexedDB 行对象是纯数据，但序列化检查在开发期仍有价值；这里保持默认并放宽时间戳阈值
      serializableCheck: {
        warnAfter: 128,
      },
    }),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

/** 类型化的 hooks，页面统一使用（禁止直接用未类型化的 useSelector） */
export const useAppDispatch = (): AppDispatch => useDispatch<AppDispatch>();
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;

export default store;
