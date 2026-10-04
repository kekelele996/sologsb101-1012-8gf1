# sologsb101-1012 地震台阵仪器标定与布设台账

面向地震台阵建设与运维班组的纯前端单页应用：把台站布设、仪器安装、送检登记与计量站出车批次、逐台标定结论写成可追溯的台账。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

**两份分开对账**：运维班按台站记仪器安装位置和送检登记；计量站按出车批次记出车日期、能带台数和逐台结论。两边按**台站码 + 序列号**对账，对不上的先挂着等确认、不写结论；批次名额满了后面登记的排队等下一趟，已出车的照旧不动；计量站退回某台只退这一台，其余照旧入库，对账失败后按运维班这侧重试。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22812**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22812）。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18.3（函数组件 + Hooks） | 页面全部 `lazy` 懒加载并 `Suspense` 兜底 |
| 语言 | TypeScript 5.6（strict） | 构建脚本执行 `tsc --noEmit` 类型检查 |
| UI 组件 | Ant Design 5.22 + @ant-design/icons | 中文语言包，表格 / 表单 / Modal / 徽标 |
| 构建 | Vite 5 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Redux Toolkit 2 + react-redux 9 | `arraySlice` / `instrumentSlice` / `calibrationSlice` / `submissionSlice` / `dispatchSlice` |
| 路由 | React Router 6（`createBrowserRouter`） | 路径与提示词逐字一致，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB，库名 `gbseisarray`） | 结构版本 v3 + upgrade 迁移 + liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/arrays` | 台阵与台站台账 | Array、Station、Instrument | 新建/编辑/删除台阵，按布设日期、运行状态与孔径分档筛选；卡片回显台站数、仪器数与标定合格率，可一键按经纬度重算孔径 |
| `/stations/:id/instruments` | 台站仪器登记与安装位置维护 | Station、Instrument、Submission | 新增/编辑/删除台站（经纬度范围校验 + 度分秒显示、基岩类型、高程），登记仪器（类型/型号/序列号**唯一性校验**/安装日期/状态），登记后自动生成下一次标定待办；**送检登记**（按台站码+序列号，提交后 FIFO 排队进入筹备中批次） |
| `/calibrations` | 出车批次与对账（计量站） | DispatchBatch、BatchItem、Submission、Calibration、Instrument | 新建出车批次（出车日期+能带台数）、逐台录入灵敏度/自噪/结论、按台站码+序列号与运维班对账（对上写结论、对不上挂起不写）、退回只退该台、按运维班重试、历史标定切批次、已对账结论与趋势只读 |
| `/replacements` | 合格评定与更换提醒 | Replace、Calibration、Instrument | 按 365 天标定周期评定，超期未标定与不合格仪器高亮；登记更换并推进状态机（待更换→已更换→已复核），流转到「已更换」时回写仪器序列号 |
| `/geometry` | 台阵几何视图与结构版本 | 全部模型 | 实算孔径与台站间距、SVG 几何平面图与辐射距离、按台阵汇总标定结论、结构版本查看、全量 JSON 导入导出 |

带 `:id` 的层级路由在直接深链访问时同样可用：若 IndexedDB 中查不到该台阵，页面渲染 `<RouteMissingPanel>` 友好空态（含「返回台阵台账」与可用 id 快捷跳转），不会白屏。

## 四、目录结构

```
sologsb101-1012/
├── README.md
├── docker-compose.yml          # name: gbseisarray，不写 version
├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf              # 前端独立托管用
    ├── .dockerignore
    ├── package.json            # build = tsc --noEmit && vite build
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.tsx            # Provider + ConfigProvider + RouterProvider
        ├── App.tsx             # 侧边导航 + 顶部上下文条 + 页脚，并启动各表订阅
        ├── types/              # array / station / instrument / calibration / replace / filter
        ├── stores/             # arraySlice / instrumentSlice / calibrationSlice / store.ts
        ├── components/common/  # QualifyTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
        ├── hooks/              # useIdbTable / useCalibHistory
        ├── pages/              # ArrayList / StationInstruments / CalibrationBoard / ReplaceBoard / GeometryView
        ├── router/index.tsx    # 路由表（路径与提示词逐字一致）
        ├── styles/main.css
        └── utils/              # geo.ts（Haversine/孔径）/ db.ts（Dexie 封装）/ export.ts（导入导出与结论）
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22812
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览构建产物
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gbseisarray`，当前结构版本 `v3`。读写统一经 `frontend/src/utils/db.ts` 封装，页面组件不直接触碰 Dexie 实例。
- **数据表**：`arrays`（台阵）、`stations`（台站）、`instruments`（仪器，运维班安装位置）、`submissions`（送检登记，运维班侧）、`dispatchBatches`（出车批次，计量站侧）、`batchItems`（逐台结论，计量站侧）、`calibrations`（已对账标定结论）、`replaces`（更换）。
- **两份分开与对账**：运维班在台站仪器页登记送检（`submissions`，业务键 台站码+序列号）；计量站在出车批次页建批次（`dispatchBatches`，出车日期+能带台数）并录入逐台结论（`batchItems`）。两边按 台站码+序列号 对账：对上了才把结论写回仪器（生成 `calibrations`），对不上挂起（`对账失败`）等确认、不写结论。批次有名额，送检登记按 FIFO 排队进入筹备中的批次，满了等下一趟；已出车批次锁定不再加台。退回只退该台（`已退回`），其余照旧入库；对账失败后可按运维班这侧重试。
- **升级迁移**：`db.version(1)` 保留初版结构，`db.version(2).stores(...).upgrade(...)` 补齐索引与时间戳，`db.version(3).stores(...)` 新增送检登记、出车批次、逐台结论三张表；调整字段结构时递增 `DB_VERSION` 并补迁移。
- **历史切批**：旧标定没有出车批次，升级后（及演示数据播种后）`sliceLegacyBatches()` 按「标定日期 + 机构」把旧标定切出车批次（已完成）挂回台站；切不出来的（缺日期/缺机构/找不到仪器台站）单列在出车批次页，补录后可重切。
- **首屏播种**：`initDatabase()` 在 `arrays` 表为空时执行幂等播种，生成四层互相引用的演示数据（2 个台阵 / 5 个台站 / 8 台仪器 / 10 条标定 / 3 条更换），并刻意包含：1 次不合格标定（自噪超标）、2 台超期未标定仪器、3 条不同状态的更换记录，保证每个页面打开都有内容与可演示的状态；播种后自动把旧标定切为历史批次。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，`App.tsx` 挂载时启动订阅并把数据 dispatch 到 Redux slice，页面只读 selector。
- **业务规则**：标定周期 365 天（超期即在更换提醒页高亮）；响应结论自动初判规则为「灵敏度落在类型区间内（宽频带 800~3000、短周期 100~800、强震 0.1~5）且自噪 ≤ 3.5」，最终以标定报告为准；仪器序列号全局唯一；更换状态机为 待更换 → 已更换 → 已复核，流转到「已更换」时把新序列号回写到仪器档案并置为在用。
- **备份与恢复**：`/geometry` 页可导出包含八张表的 JSON 快照，支持「覆盖导入」与「追加导入（重新分配 id）」；备份时间写入 `localStorage`，页脚与几何页均展示结构版本号。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器或清空站点数据后数据不跟随，需通过 JSON 备份迁移。
