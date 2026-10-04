import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';
import './styles/main.css';
import { appRoutes } from './router';
import { store } from './stores/store';

const theme = {
  token: {
    colorPrimary: '#1e3a5f',
    colorInfo: '#3f7bbf',
    colorSuccess: '#1e8449',
    colorWarning: '#d68910',
    colorError: '#c0392b',
    colorTextBase: '#16232e',
    borderRadius: 8,
    fontFamily:
      '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif',
  },
  components: {
    Layout: { headerBg: '#ffffff', siderBg: '#16283f' },
    Card: { headerBg: '#f7fafc' },
    Table: { headerBg: '#f2f6fb' },
  },
};

const container = document.getElementById('root');
if (!container) {
  throw new Error('未找到 #root 挂载节点');
}

/** 路由由 src/router/index.tsx 提供，App 负责整体布局与外层导航 */
const router = createBrowserRouter(appRoutes);

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <Provider store={store}>
      <ConfigProvider locale={zhCN} theme={theme}>
        <AntdApp>
          <RouterProvider router={router} />
        </AntdApp>
      </ConfigProvider>
    </Provider>
  </React.StrictMode>
);
