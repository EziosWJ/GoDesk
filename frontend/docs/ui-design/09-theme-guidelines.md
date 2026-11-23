# 09 · 浅色与深色主题

主题在根节点统一切换，同一角色在浅色和深色使用各自值。标题栏、工具栏、表格、检查器、开始菜单和弹窗共用中性色、鸢尾紫强调色和独立的状态色。浅色用雾白底和白色工作面，深色用炭黑底和逐层提亮的窗口及浮层。 [Windows 配色指南](https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/color) · [Fluent 2 色彩规范](https://fluent2.microsoft.design/color)

## 主题选择

- 选项为「跟随系统」「浅色」「深色」。首选跟随系统，读取 `prefers-color-scheme` 并在系统变化时同步。显式选择覆盖系统，并可保存在本地偏好中。Apple HIG 建议尽量避免应用单独提供外观偏好。React Web Desktop 把覆盖选项放在桌面外壳，各内置应用共用该偏好。 [Apple Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode)
- 首次绘制前将解析后的主题应用到页面根节点的 `data-theme`，并设置相应的 `color-scheme`。表单、滚动条、弹窗和 Portal 使用同一根节点的主题。
- 壁纸和外观可独立选择。鸢尾、暮紫和灰阶壁纸都随浅色与深色切换。

## 材质与可读性

- 颜色、圆角、阴影取自 [02](02-design-tokens.md)。内容区、操作菜单、弹窗使用实色表面。相邻窗格的深浅关系用于区分区域，重要边界同时能通过分割线或清晰标记识别。
- 任务栏使用实色 `shell`。快捷方式名称使用 `fg`，悬停和选中状态在整个快捷方式上呈现。强制色彩模式隐藏壁纸渐变，使用系统颜色显示选择标记。
- 两种主题分别定义色值。文件管理器通过侧栏、工具栏和主列表的明度区分区域，用整项底色和名称加粗表示选中。强制色彩模式使用系统选中底色和文字色。监控面板通过标题、实线和虚线区分 CPU 与内存。服务状态同时使用颜色、文字和图标。壁纸和应用入口图标可以使用渐变。
- Monaco 和 xterm.js 从共享 CSS 变量读取背景、正文和选区颜色。Monaco 继承各自基础主题的语法高亮，终端蓝色提示使用 `info`。
- 保证焦点环在选中、实底按钮和密集滚动区等环境可见。实底按钮可用偏移分隔环与按钮填色。强制色彩模式保留系统颜色边线及标记，不能仅依赖阴影表达焦点或分隔。对比度验收见 [07](07-interaction-guidelines.md)。

## 开发验收

分别检查两种主题和跟随系统模式，覆盖激活与非激活窗口、菜单、模态弹窗、四种状态提示、表格选中、键盘焦点、壁纸上的快捷方式和任务栏。验证主题切换后时间、窗口状态、应用输入和当前焦点仍正确。按根节点颜色切换变量，通过 `@theme inline` 使用同一批 Tailwind 类。 [02 设计 Token](02-design-tokens.md) · [Tailwind CSS Dark mode](https://tailwindcss.com/docs/dark-mode)
