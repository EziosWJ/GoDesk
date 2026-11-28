# 09 · 主题、强调色与材质

goDesk 在文档根节点 `<html>` 上统一管理三项独立外观偏好：`data-theme`（浅色/深色）、`data-accent`（强调色）以及桌面层 `data-wallpaper`（壁纸）。登录页与桌面外壳共享同一套偏好，确保进入前后的视觉连贯性。

## 主题与强调色管理

- **主题模式（`godesk-theme`）**：支持「跟随系统（默认）」「浅色」「深色」，监听 `prefers-color-scheme` 变化并实时更新 `document.documentElement.dataset.theme` 与 `color-scheme`。
- **强调色（`godesk-accent`）**：默认 `blue`（Win11 系统蓝），可选 `iris`（鸢尾紫）、`teal`（青碧）、`amber`（琥珀）、`rose`（玫瑰）。所有主按钮、选中状态、任务栏激活胶囊条、导航选中竖条、监控主曲线与登录按钮均自动响应当前强调色。
- **零闪烁首屏引导**：`frontend/index.html` 内联脚本在首帧绘制前同步解析并写入 `data-themePreference`、`data-theme` 与 `data-accent`。
- **实时多端同步**：`frontend/src/theme.ts`（`subscribeAppearance`）与 `frontend/src/wallpapers.ts`（`subscribeWallpaper`）提供订阅机制；无论在「系统设置 → 外观」、任务栏「快捷控制与通知」还是桌面右键菜单修改外观，其余界面均即时同步。

## 壁纸系统（`godesk-wallpaper`）

- 内置 5 套轻量化矢量自适应壁纸：`bloom`（蓝韵花瓣，默认）、`aurora`（极光云雾）、`prism`（暮紫棱镜）、`sunset`（晨曦琥珀）、`graphite`（静谧灰阶）。
- 每套壁纸均提供浅色与深色双版本 SVG，随 `data-theme` 自动切换，并同步应用于桌面背景与登录页背景。

## Fluent 2 材质与降级策略

- **Acrylic 磨砂层**：用于任务栏（`--godesk-acrylic-bg`）、开始菜单、任务栏弹出面板与登录卡片（`--godesk-acrylic-strong`），配合 `backdrop-filter: var(--godesk-acrylic-blur)`、发丝边框与 `inset 0 1px var(--godesk-acrylic-highlight)` 顶部内高光。
- **Mica 层次面**：用于窗口标题栏（`--godesk-mica-bg` / `--godesk-mica-inactive`）与系统设置、文件管理器侧边栏，与纯白/深碳主内容区形成克制的层次对比。
- **第三方嵌入式组件同步**：Monaco 编辑器与 xterm.js 终端从共享 `--godesk-*` CSS 变量读取背景、前景、选区与语义色，切换浅/深主题时同步更新。
- **强制色彩降级（`forced-colors: active`）**：自动关闭全部壁纸背景、文字阴影与 `backdrop-filter` 模糊，所有 Acrylic/Mica 表面回退至 `Canvas`，应用图标切换为高对比单色矢量回退图标，选中与焦点改用 `Highlight` / `HighlightText` 系统色。
