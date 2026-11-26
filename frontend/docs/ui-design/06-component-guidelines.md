# 06 · 基础组件

基础组件优先使用原生语义元素（`<button>`、`<input>`、`<table>`、`<dialog>`）与 Radix Menu 菜单原语，颜色、圆角、阴影与动效取自 [02 设计 Token](02-design-tokens.md)。

## 选中、导航与状态表达

- **侧栏导航选中态（NavigationView）**：系统设置与文件管理器的侧栏当前项采用 `--godesk-selected` 柔和高亮底、强调色前景与左侧 `3px` 圆角强调色竖条指示器；普通表格行与列表行使用整项 `--godesk-selected` 底色（文件列表同时加粗选中名称）。
- **语义状态双通道**：健康状态、服务状态、扩展运行状态及端口状态必须同时提供语义色、图标与文字，不单独依赖颜色。
- **独立焦点环**：键盘焦点使用 `2px solid var(--godesk-focus)`，可与选中、悬停态共存；实底主按钮焦点环留出外偏移避免与实底粘连。

## 按钮、输入与画廊控件

| 组件 | 规格与样式 | 行为约定 |
| --- | --- | --- |
| 主按钮 (`.primary-control`) | `--godesk-accent` / `--godesk-on-accent`，标准/紧凑高度 | 每个操作组突出一个主要动作，支持 hover/pressed 强调色反馈 |
| 次按钮与工具栏按钮 (`.app-control`) | 中性表面，悬停 `--godesk-hover`，按下 `--godesk-pressed` | 图标独用时提供 `aria-label` 与提示；切换态以 `aria-pressed` 表达 |
| 危险按钮 (`.danger-control`) | `--godesk-danger` / `--godesk-on-danger` | 用于不可逆确认（退出登录、停止/禁用服务、删除文件） |
| 文本与搜索输入 | 发丝边框 `--godesk-border`，聚焦显示 `--godesk-focus` | 开始菜单搜索采用胶囊圆角并带一键清除按钮；错误状态标红并关联 `role="alert"` |
| 个性化预览卡与色板 | 可视化缩略预览 + 隐藏原生 `<input type="radio">` 保持键盘语义 | 通过 `:has(input:checked)` 与 `:has(input:focus-visible)` 呈现强调描边与焦点环 |

## 表格与图表

- 表格采用原生语义与 `tabular-nums` 等宽数字右对齐；窄容器按列优先级折叠次要列并在容器内局部横向滚动。
- 系统监控趋势图使用 SVG `<linearGradient>` 面积渐变与 `vectorEffect="non-scaling-stroke"` 折线，指针移动时展示竖向参考线、数据圆点与当前时刻精确读数浮标，同时保留完整的 `aria-label` 极值摘要。

## 菜单、浮层、通知与模态弹窗

| 组件 | 材质与行为 |
| --- | --- |
| 命令菜单 / 右键菜单 (`CommandMenu`) | 基于 `@radix-ui/react-menu`，发丝边框 + 柔和阴影，支持桌面、插件快捷方式、任务栏图标与开始菜单应用图标上下文操作，自动防视口溢出与焦点恢复 |
| 任务栏非模态浮层 (`HealthPanel` / `QuickSettingsPanel` / 更多应用) | 采用 Acrylic 强磨砂背景（`--godesk-acrylic-strong` + `--godesk-acrylic-blur`）、发丝边框与顶部内高光；Escape、外部点击或再次点击触发器关闭并将焦点归还触发器 |
| 桌面通知与 Toast | 桌面级错误/状态提示集中归档至右下角「快捷控制与通知」面板，新消息到来时在任务栏上方短暂浮出非阻塞 Toast，支持单条关闭与一键清空 |
| 模态弹窗 (`.service-dialog` / `.extension-dialog`) | 使用原生 `<dialog>` + `showModal()`，首选宽度 `440px`（两侧留至少 `12px`），遮罩 `--godesk-scrim`，Escape 取消，关闭后恢复原触发焦点 |
