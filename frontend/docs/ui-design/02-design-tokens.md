# 02 · 设计 Token

本页是 React Web Desktop 共享颜色、尺寸和动效的参数来源。表中数值均为 **React Web Desktop 自定义基线**。来源为外部标准的验收阈值见 [07](07-interaction-guidelines.md)。Fluent 2 提供了设计 Token 的组织方式。React Web Desktop 使用语义角色和主题映射，并采用自己的色值与尺寸。 [Fluent 2 Design tokens](https://fluent2.microsoft.design/design-tokens)

## 颜色

CSS 原始语义变量统一使用 `--react-web-desktop-<角色>`，可在 Tailwind 中经 `--color-react-web-desktop-<角色>` 暴露。下面列出的状态填色均为实色，避免透明层叠后颜色随背景变化。

| 角色 | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `canvas` | `#F2F1F3` | `#18181B` | 桌面底色、无壁纸时的回退 |
| `surface` | `#FFFFFF` | `#202023` | 窗口主内容、表格 |
| `subtle` | `#F7F6F8` | `#262629` | 工具栏、属性面板、次级背景 |
| `panel` | `#F6F4FB` | `#282631` | 非活动标题栏、应用侧栏、监控卡片外层 |
| `window-title-active` | `#EFEAF9` | `#332C40` | 活动窗口的标题栏 |
| `raised` | `#FFFFFF` | `#2B2A2E` | 菜单、弹窗 |
| `shell` | `#F2F1F3` | `#18181B` | 任务栏实色及模糊不支持时的回退 |
| `fg` | `#242326` | `#F3F2F5` | 主文字、默认图标 |
| `muted` | `#5D5963` | `#BDB8C3` | 次级文字、时间和说明 |
| `divider` | `#DDDADF` | `#3D3A41` | 装饰性分割线 |
| `border` | `#807A85` | `#827D8A` | 必须可辨认的控件边界 |
| `window-border` | `#BEB7CC` | `#595268` | 非活动窗口边框，活动边框混入 60% 的 `accent` |
| `hover` | `#E9E7EB` | `#343238` | 中性控件悬停 |
| `pressed` | `#DEDCE1` | `#403D45` | 中性控件按下 |
| `selected` | `#EEE9FA` | `#383048` | 整项或整行的选中背景，可搭配名称加粗 |
| `accent` | `#6246B5` | `#BBA7FA` | 主按钮背景、选中标记、可交互链接 |
| `accent-hover` | `#543A9F` | `#CDBEFF` | 主按钮悬停背景 |
| `accent-pressed` | `#483285` | `#AA92EF` | 主按钮按下背景 |
| `on-accent` | `#FFFFFF` | `#211A30` | 主按钮文案与图标 |
| `focus` | `#6246B5` | `#BBA7FA` | 键盘焦点环 |
| `success` | `#186344` | `#88D6AF` | 正常、已完成 |
| `warning` | `#784800` | `#F6CC86` | 需注意、风险 |
| `danger` | `#A3293D` | `#FF9BAA` | 失败、危险操作 |
| `on-danger` | `#FFFFFF` | `#18181B` | 危险实底按钮文案与图标 |
| `info` | `#285984` | `#9FC5EA` | 信息、处理中 |
| `disabled` | `#77727C` | `#8C8693` | 禁用控件文字与图标 |
| `scrim` | `rgb(24 24 27 / 42%)` | `rgb(0 0 0 / 56%)` | 模态遮罩 |

大面积表面用中性色。主按钮使用 `accent` 与 `on-accent`，选中背景使用 `selected`，键盘焦点单独使用 `focus` 描边。状态前景用于 `surface`、`subtle` 或 `raised`，并搭配文字或图标。壁纸渐变色值定义在桌面样式中。 [Fluent 2 色彩规范](https://fluent2.microsoft.design/color) · [主题规范](09-theme-guidelines.md)

## 字体与图标

界面使用 `--react-web-desktop-font-ui`，拉丁字母与数字优先用 Figtree Variable，简体中文优先用 Noto Sans SC Variable。终端、代码、路径和等宽标识使用 `--react-web-desktop-font-mono`，优先用 JetBrains Mono Variable。三套字体由 Fontsource 自托管，系统字体提供回退，OFL 许可证随构建产物分发。表格数值与时钟使用 `tabular-nums`。

| Token | 字号 / 行高 | 场景 |
| --- | --- | --- |
| `text-react-web-desktop-caption` | 12 / 16 | 辅助说明、文件元数据、次级时间。中文用 400 字重 |
| `text-react-web-desktop-compact` | 13 / 18 | 紧凑菜单和路径用 400 字重，表头和面板分组标题用 500 |
| `text-react-web-desktop-body` | 14 / 20 | 正文、文件名、应用名称用 400 字重，工具栏操作用 500 |
| `text-react-web-desktop-subtitle` | 16 / 24 | 分组标题、关键指标标签用 600 字重 |
| `text-react-web-desktop-title` | 20 / 28 | 页面、弹窗标题用 600 字重 |
| `text-react-web-desktop-metric` | 28 / 36 | 核心指标读数用 600 字重 |

桌面、开始菜单和任务栏提示里的应用名，与文件图标下的文件名使用相同的 14 / 20 / 400 排版。Noto Sans SC 在 12 px 加粗时，笔画密集的字容易挤在一起。中文辅助文字最小用 12 px / 400，需要强调的紧凑文字升到 13 px / 500，标题需要 600 字重时至少用 14 px。布局变窄时优先允许换行或调整列宽。验收时用「系统设置」「文件管理器」等实际文案，在浅色、深色及 100%、125%、150% 缩放下检查笔画和裁切。

字号与行高以 16 px 根字号给出，CSS 使用 `rem`。Lucide 的常用尺寸是 16（行内、标题栏控制图标）、20（工具栏、任务栏）、24（桌面快捷方式）。图标尺寸和命中区各自定义。

## 间距、圆角与高程

- 间距标尺为 4、8、12、16、20、24、32、40、48、56 px，对应 Tailwind 默认 4 px 标尺下的 `1、2、3、4、5、6、8、10、12、14`。例如 `gap-2`、`p-4`、`px-6`。组件语义尺寸优先用下表的变量。
- 圆角 `rounded-react-web-desktop-control` 6 px，`rounded-react-web-desktop-overlay` 8 px，`rounded-react-web-desktop-window` 12 px。最大化窗口和贴合工作区的移动端应用视图为 0。
- `shadow-react-web-desktop-overlay` 用于菜单与弹窗，浅色 `0 6px 18px rgb(24 24 27 / 16%)`，深色 `0 6px 18px rgb(0 0 0 / 45%)`。
- `--react-web-desktop-shadow-window` 用于普通窗口，`--react-web-desktop-shadow-window-active` 用于活动窗口。两者都通过近距离与远距离阴影表达高程，具体数值见 [theme.css](../../src/styles/theme.css)。平面内容用 1 px 分割线，窗口堆叠由 [04](04-window-guidelines.md) 定义。

## 尺寸与动效

| 参数 | CSS 变量或约定 | 基线 |
| --- | --- | --- |
| 任务栏内容高度 | `--react-web-desktop-taskbar` | 56 px，底部安全区另计 |
| 标题栏 / 工具栏最小高度 | `--react-web-desktop-titlebar` / `--react-web-desktop-toolbar` | 44 / 44 px |
| 紧凑 / 标准 / 触控目标 | `--react-web-desktop-control-compact` / `--react-web-desktop-control` / `--react-web-desktop-control-touch` | 32 / 36 / 44 px |
| 标题栏控制（精细指针） | 宽用标准，高用紧凑 | 每个 36 × 32 px |
| 表头与数据行最小高度 | `--react-web-desktop-row-compact` / `--react-web-desktop-row` | 32 / 40 px，触控时可交互行至少 44 px |
| 内容内边距 | 紧凑 / 标准 | 12 / 16 px |
| 分栏尺寸 | 导航最小 / 首选，主区最小，检查器最小 / 首选 | 192 / 224，360，256 / 288 px |
| 普通浮动窗口 | 最小，通用首次打开建议 | 320 × 240，720 × 480 CSS px |
| 漂移保留范围 | `minVisible` 起点，最终按抓取区验收 | 176 CSS px；具体见 [04](04-window-guidelines.md) |
| 浮动窗口缩放热区 | 边 / 角，精细指针 | 6 / 12 CSS px |
| 视口与应用容器断点 | 视口；应用双栏 / 三栏 | 640；600 / 960 CSS px，见 [08](08-responsive-guidelines.md) |
| 焦点环 | 宽度 / 偏移 | 2 / 2 CSS px；允许内绘以防裁切 |
| 过渡 | `--react-web-desktop-duration-feedback` / `--react-web-desktop-duration-overlay` | 120 / 180 ms，`ease-out`，减少动效时去掉装饰过渡 |

触控目标在宽、高两个方向均至少 44 CSS px。标题栏、工具栏和数据行尺寸为最小值，允许因字体缩放和换行而增高。任务栏 56 px 是默认内容高度，窄屏不通过缩小命中区换空间。

## Tailwind CSS 4 对应关系

原始色值在 `src/styles/theme.css` 的 `:root` 与 `:root[data-theme="dark"]` 声明，通过顶层 `@theme inline` 映射到 Tailwind。 [Tailwind CSS Theme variables](https://tailwindcss.com/docs/theme)

```css
@import "tailwindcss";

:root {
  --react-web-desktop-surface: #FFFFFF;
  --react-web-desktop-fg: #242326;
  --react-web-desktop-control: 2.25rem;
  --react-web-desktop-shadow-window: 0 2px 5px rgb(39 27 65 / 7%), 0 10px 28px rgb(39 27 65 / 13%);
}

:root[data-theme="dark"] {
  --react-web-desktop-surface: #202023;
  --react-web-desktop-fg: #F3F2F5;
  --react-web-desktop-shadow-window: 0 2px 6px rgb(0 0 0 / 22%), 0 10px 28px rgb(0 0 0 / 34%);
}

@theme inline {
  --color-react-web-desktop-surface: var(--react-web-desktop-surface);
  --color-react-web-desktop-fg: var(--react-web-desktop-fg);
  --spacing-react-web-desktop-control: var(--react-web-desktop-control);
  --text-react-web-desktop-body: 0.875rem;
  --text-react-web-desktop-body--line-height: 1.25rem;
  --radius-react-web-desktop-window: 0.75rem;
  --shadow-react-web-desktop-window: var(--react-web-desktop-shadow-window);
  --container-react-web-desktop-split: 600px;
  --container-react-web-desktop-wide: 960px;
}
```

| 命名空间 | 使用示例 |
| --- | --- |
| `--color-react-web-desktop-*` | `bg-react-web-desktop-surface text-react-web-desktop-fg border-react-web-desktop-border` |
| `--spacing-react-web-desktop-*` | `min-h-react-web-desktop-control`，其他语义尺寸按同一命名方式映射 |
| `--text-react-web-desktop-*` / `--font-react-web-desktop-*` | `text-react-web-desktop-body font-react-web-desktop-mono` |
| `--radius-react-web-desktop-*` / `--shadow-react-web-desktop-*` | `rounded-react-web-desktop-window shadow-react-web-desktop-window` |
| `--container-react-web-desktop-*` | `@react-web-desktop-split/app:*`、`@react-web-desktop-wide/app:*`，父元素为 `@container/app` |

WMKit 的几何值以 CSS px 传入。后续迁移时用同一份定义或契约测试同步 CSS 与 TS，避免颜色、状态和窗口尺寸分散在组件中。
