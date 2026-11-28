# 02 · 设计 Token

本页定义 goDesk 前端的共享色彩、材质、字体、尺寸、圆角、阴影与动效基线。原始 CSS 变量统一声明于 `frontend/src/styles/theme.css`，前缀为 `--godesk-*`，并通过 Tailwind CSS 4 `@theme inline` 映射为工具类变量。

## 中性色板与材质 Token

| 角色 | 浅色 (`light`) | 深色 (`dark`) | 用途 |
| --- | --- | --- | --- |
| `--godesk-canvas` | `#F3F3F3` | `#1C1C1C` | 桌面回退底色、壁纸兜底 |
| `--godesk-surface` | `#FFFFFF` | `#202020` | 窗口主内容面、表格、卡片表面 |
| `--godesk-subtle` | `#F9F9F9` | `#272727` | 工具栏、次级区域、状态栏 |
| `--godesk-panel` | `#F6F6F6` | `#2C2C2C` | 侧栏、监控背景面板、Mica 活动基面 |
| `--godesk-raised` | `#FCFCFC` | `#323232` | 菜单、浮层、对话框实色回退面 |
| `--godesk-shell` | `#F4F4F4` | `#202020` | 任务栏实色回退面 |
| `--godesk-fg` | `#242424` | `#F5F5F5` | 主文字与高对比前景 |
| `--godesk-muted` | `#595959` | `#C0C0C0` | 次级文字、时间与说明 |
| `--godesk-divider` | `rgb(0 0 0 / 7%)` | `rgb(255 255 255 / 8%)` | 发丝分割线 |
| `--godesk-border` | `#00000026` | `#FFFFFF26` | 可交互控件边界 |
| `--godesk-window-border` | `rgb(0 0 0 / 12%)` | `rgb(255 255 255 / 12%)` | 窗口与浮层发丝外边框 |
| `--godesk-hover` | `#EDEDED` | `#363636` | 中性悬停底色 |
| `--godesk-pressed` | `#E5E5E5` | `#404040` | 中性按下底色 |
| `--godesk-acrylic-bg` | `rgb(249 249 249 / 78%)` | `rgb(32 32 32 / 78%)` | 任务栏 Acrylic 毛玻璃底色 |
| `--godesk-acrylic-strong` | `rgb(252 252 252 / 92%)` | `rgb(44 44 44 / 92%)` | 开始菜单、弹出浮层、登录卡片强磨砂底色 |
| `--godesk-acrylic-blur` | `blur(28px) saturate(160%)` | 同左 | Acrylic 背景模糊滤镜 |
| `--godesk-acrylic-highlight` | `rgb(255 255 255 / 65%)` | `rgb(255 255 255 / 8%)` | 顶部发丝内高光线 |
| `--godesk-mica-bg` | `var(--godesk-panel)` | 同左 | 激活窗口标题栏与侧边栏 Mica 层级 |
| `--godesk-mica-inactive` | `var(--godesk-shell)` | 同左 | 非激活窗口标题栏背景 |
| `--godesk-success` / `warning` / `danger` / `info` | `#186344` / `#784800` / `#A3293D` / `#285984` | `#88D6AF` / `#F6CC86` / `#FF9BAA` / `#9FC5EA` | 运维语义状态前景色 |

在 `@media (forced-colors: active)` 下，全部 Acrylic 与 Mica 变量自动回退为 `Canvas` / `none` / `transparent`。

## 强调色预设（`data-accent`）

通过 `html[data-accent="<id>"]` 驱动 `--godesk-accent`、`--godesk-accent-hover`、`--godesk-accent-pressed`、`--godesk-on-accent`、`--godesk-focus`、`--godesk-selected`，所有 10 种亮/暗组合在按钮态与选中面均满足 WCAG AA（≥ 4.5:1）：

| 预设 ID | 名称 | 浅色强调色 | 深色强调色 |
| --- | --- | --- | --- |
| `blue`（默认） | 系统蓝 | `#0067C0` | `#60CDFF` |
| `iris` | 鸢尾紫 | `#6246B5` | `#BBA7FA` |
| `teal` | 青碧 | `#007C7B` | `#4FD1C5` |
| `amber` | 琥珀 | `#B45309` | `#FBBF24` |
| `rose` | 玫瑰 | `#BE185D` | `#F472B6` |

## 字体与排版

- UI 字体：`--godesk-font-ui`（`"Figtree Variable", "Noto Sans SC Variable", "Microsoft YaHei UI", "PingFang SC", "Segoe UI", sans-serif`）
- 等宽字体：`--godesk-font-mono`（`"JetBrains Mono Variable", "Cascadia Code", "Consolas", "SFMono-Regular", monospace`）
- 数值与时钟统一启用 `font-variant-numeric: tabular-nums`。

| Token | 字号 / 行高 | 典型用途 |
| --- | --- | --- |
| `--text-godesk-caption` | 12 / 16 px | 元数据、辅助说明、图标辅助标签 |
| `--text-godesk-compact` | 13 / 18 px | 菜单项、桌面图标名称、路径、表头 |
| `--text-godesk-body` | 14 / 20 px | 正文、文件名、标题栏标题、按钮文案 |
| `--text-godesk-subtitle` | 16 / 24 px | 分组标题、指标卡片标题 |
| `--text-godesk-title` | 20 / 28 px | 页面主标题 |
| `--text-godesk-metric` | 28 / 36 px | 系统监控核心读数 |

## 尺寸、圆角与动效

| 参数 | CSS 变量 | 基线 |
| --- | --- | --- |
| 任务栏高度 | `--godesk-taskbar` | `48px`（另加 `env(safe-area-inset-bottom)`） |
| 窗口标题栏高度 | `--godesk-titlebar` | `38px`（触控自动升至 `44px`） |
| 工具栏最小高度 | `--godesk-toolbar` | `44px`（文件管理器紧凑顶栏采用 `38px`） |
| 紧凑 / 标准 / 触控控件 | `--godesk-control-compact` / `--godesk-control` / `--godesk-control-touch` | `32 / 36 / 44 px` |
| 紧凑 / 标准列表行 | `--godesk-row-compact` / `--godesk-row` | `32 / 40 px` |
| 圆角 | `--godesk-radius-control` / `overlay` / `window` | `6 / 8 / 12 px`（最大化窗口为 `0`） |
| 动效时长 | `--godesk-duration-feedback` / `overlay` | `120 / 180 ms`，`ease-out` |
| 应用容器断点 | `--container-godesk-split` / `wide` | `600 / 960 px`（`@godesk-split/app`、`@godesk-wide/app`） |

## 偏好持久化键

| 偏好项 | Key |
| --- | --- |
| 主题模式 | `godesk-theme` |
| 强调色 | `godesk-accent`（默认 `blue`） |
| 桌面壁纸 | `godesk-wallpaper`（默认 `bloom`；旧值 `iris`/`lavender` 映射为 `prism`） |
| 任务栏固定应用 | `godesk-pinned-apps`（默认 `files, editor, terminal, monitor, services`） |
| 窗口尺寸记忆 | `godesk-window-size:<group>` |
| 插件桌面快捷方式 | `godesk-extension-shortcuts` |
