# 02 · 前端页面骨架、工具栏与状态栏

Status: ready-for-human

重写 Services 应用外壳：布局、两行工具栏、chips、状态栏、刷新调度与窗口默认尺寸。

## 范围

- 重写 `frontend/src/Services.tsx` 为页面骨架（数据获取、选中、刷新调度）；新增 `ServiceList.tsx` / `ServiceDetail.tsx` / `ServiceLogs.tsx` 占位，供 02–05 逐步填充。
- 删除应用内大标题行；后端名移到底部状态栏，计数进入 chips。
- 两行工具栏：搜索框 + 刷新 + 排序菜单；chips 全部/运行中/未运行/异常（带计数，计数基于搜索结果计算）。
- 分栏 40/60、最小 320/420、6px 分隔条、双击复位、阈值 746px、窄窗口串行 +「返回列表」。
- 刷新：打开加载、可见且未最小化时 10s 轮询、聚焦/可见性恢复立即刷新、手动刷新；刷新保持选中与滚动位置。
- 搜索（名称+描述、100ms 防抖、AND chips）与排序（名称升序 + 异常置顶）逻辑。
- `none` 空状态、`stateReliable=false` 警告、列表错误内联展示。
- `frontend/src/apps.ts` 服务窗口默认尺寸改 1000×640。
- 新建 `frontend/src/styles/services.css` 并迁移服务样式；删除 `App.css` 中旧 `services-*` / `service-*` 规则与死代码 `.service-stop`（**保留**共享 `.service-dialog`）。
- chips 行在 320px 最小宽度下不溢出（可横向滚动），搜索框不被压缩。

## 验收

- 工具栏紧贴列表，无跨屏空白；状态栏显示后端名与「更新于 HH:MM:SS」。
- 窗口 1000×640 默认分栏；拖到 <746px 进入串行并可用「返回列表」返回。
- 轮询在最小化/不可见时停止；聚焦恢复立即刷新；刷新后选中与滚动位置保持。
- chips 计数随搜索结果变化，切换 chip 后 AND 过滤正确。
- `pnpm --dir frontend lint` 与 `pnpm --dir frontend build` 通过。
