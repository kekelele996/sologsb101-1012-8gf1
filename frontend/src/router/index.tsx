/**
 * 路由表：/arrays、/stations/:id/instruments、/calibrations、/replacements、/geometry
 * 路径与提示词逐字一致；页面按路由懒加载，构建时自动分包。
 */
import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import { Skeleton } from 'antd';
import App from '@/App';

const ArrayList = lazy(() => import('@/pages/ArrayList'));
const StationInstruments = lazy(() => import('@/pages/StationInstruments'));
const CalibrationBoard = lazy(() => import('@/pages/CalibrationBoard'));
const DispatchLedger = lazy(() => import('@/pages/DispatchLedger'));
const BatchBoard = lazy(() => import('@/pages/BatchBoard'));
const ReplaceBoard = lazy(() => import('@/pages/ReplaceBoard'));
const GeometryView = lazy(() => import('@/pages/GeometryView'));

/** 懒加载页面占位 */
function RouteFallback() {
  return (
    <Skeleton
      active
      paragraph={{ rows: 6 }}
      style={{ background: '#ffffff', padding: 16, borderRadius: 10 }}
    />
  );
}

/** 包裹懒加载页面，避免整页被 Suspense 卸载 */
function withSuspense(node: ReactNode): ReactNode {
  return <Suspense fallback={<RouteFallback />}>{node}</Suspense>;
}

export const ROUTES = {
  arrays: '/arrays',
  stations: (arrayId: string): string => `/stations/${arrayId}/instruments`,
  calibrations: '/calibrations',
  dispatches: '/dispatches',
  batches: '/batches',
  replacements: '/replacements',
  geometry: '/geometry',
} as const;

export const appRoutes: RouteObject[] = [
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Navigate to={ROUTES.arrays} replace /> },
      { path: 'arrays', element: withSuspense(<ArrayList />) },
      { path: 'stations/:id/instruments', element: withSuspense(<StationInstruments />) },
      { path: 'calibrations', element: withSuspense(<CalibrationBoard />) },
      { path: 'dispatches', element: withSuspense(<DispatchLedger />) },
      { path: 'batches', element: withSuspense(<BatchBoard />) },
      { path: 'replacements', element: withSuspense(<ReplaceBoard />) },
      { path: 'geometry', element: withSuspense(<GeometryView />) },
      { path: '*', element: <Navigate to={ROUTES.arrays} replace /> },
    ],
  },
];

export default appRoutes;
