# 01 · 设计原则与参考体系

React Web Desktop 是用于搭建浏览器内多窗口应用的前端脚手架。桌面外壳负责应用启动和窗口切换，各应用负责自己的内容、状态与操作。连续操作时应能定位当前窗口、当前对象和下一步动作。

## 设计原则

1. **沿用桌面操作习惯。** 桌面快捷方式、任务栏、开始菜单、右键菜单和自由窗口使用熟悉的操作模型。选中快捷方式、运行应用、激活窗口和键盘焦点分别表达。
2. **按任务组织信息。** 用导航定位资源，用主区完成工作，用检查器查看当前对象。工具栏贴近作用范围。服务列表、文件表格和终端保留连续的阅读空间。
3. **窗口缩放时保留任务上下文。** 布局按应用实际宽度重排。切换面板呈现形式时保留选择、筛选、输入和可恢复的焦点。
4. **反馈明确，视觉克制。** 用中性色区分桌面、工作内容和浮层，用鸢尾紫强调主要操作、选中与键盘焦点。使用分割线和留白组织内容，减少嵌套卡片。运维状态同时提供语义颜色和文字或图标。任务栏、应用正文、菜单和弹窗默认使用实色。 [Windows 配色指南](https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/color)
5. **兼顾精细指针、键盘和触控。** 高频动作在桌面上紧凑排列。保留清晰焦点、键盘路径和触控命中区，关键动作有可见入口。

## 研究结论

| 体系 | 采纳 | 按 Web 桌面场景调整 | 不适用或暂缓 |
| --- | --- | --- | --- |
| Windows / Fluent 2 | 开始入口、任务栏切换、桌面直接操作、右键上下文、标题栏按钮和双击最大化。借鉴 Fluent 的语义 Token、操作分组和反馈模式。 | React Web Desktop 只在标签页工作区内管理窗口。使用自己的 Lucide 图标、材质、密度与标题栏尺寸。不可逆操作采用明确确认。 | 原生系统热键、系统托盘集成、Mica/Acrylic 视觉、Windows 固定应用和 Snap Layouts。 |
| Apple macOS HIG | 侧边栏承载导航，工具栏承载当前视图动作，相邻窗格表达层级。检查器补充当前选择，保持高密度信息的清晰层次。 | 检查器默认是应用内面板，窄容器改为详情视图。保留 React Web Desktop 右侧窗口控制与系统字体栈。主题偏好只在桌面外壳集中设置。 | 红黄绿窗口按钮、Dock、全局菜单栏、Liquid Glass 和原生 AppKit 规则。 |
| HarmonyOS UX | 区分窗口容器与内容区，考虑普通、最小和最大尺寸，保留可找回的拖动区。根据可用宽度在通栏、双分栏和三分栏间演进。允许独立任务并行，区分模态阻断与辅助内容。 | 标题栏与工具栏在 React Web Desktop 中各自负责窗口和业务，两者跨页保持单层职责。响应式按 Web 容器和 CSS px。窗口越界用 WMKit 钳制。应用内检查器保留非模态协同，必须阻断的确认使用 Web 模态。 | HarmonyOS 原生窗口控制顺序、`vp` 数值、系统级分屏准入、沉浸式全屏与跨设备接续。 |
| W3C 与 Tailwind CSS | WCAG 2.2 AA 作为无障碍验收目标，APG 作为交互组件参考。用 Tailwind 4 主题变量和容器查询公开 Token。 | 详细对比度、命中区和开发方式见对应章节。 | 本次交付为设计规范，合规性由后续实际界面测试判定。 |

Windows 外壳行为来自 Microsoft 的系统使用与窗口指南。Fluent 2 用于组件和 Token 的组织方法。 [Fluent 2](https://fluent2.microsoft.design/) · [Windows 桌面](https://support.microsoft.com/en-us/accessibility/windows/use-a-screen-reader-to-explore-and-navigate-the-windows-desktop) · [任务栏](https://support.microsoft.com/en-us/windows/experience/personalization/customize-the-taskbar-in-windows) · [标题栏](https://learn.microsoft.com/en-us/windows/apps/design/basics/titlebar-design)

Apple 资料用于应用内结构和密度取舍。 [Apple HIG](https://developer.apple.com/design/human-interface-guidelines/) · [Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos) · [Split views](https://developer.apple.com/design/human-interface-guidelines/split-views) · [Panels](https://developer.apple.com/design/human-interface-guidelines/panels)

HarmonyOS 的原生尺寸用于理解规格层次。React Web Desktop 的 Web 尺寸见 [02](02-design-tokens.md)。 [HarmonyOS 窗口框架](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/window-0000002321868010/) · [HarmonyOS 应用设计](https://developer.huawei.com/consumer/cn/doc/doccenter-ux-design/app-design-0000002353509845/)

Web 开发及验收依据。 [WCAG 2.2](https://www.w3.org/TR/WCAG22/) · [WAI-ARIA APG](https://www.w3.org/WAI/ARIA/apg/patterns/) · [Tailwind CSS Theme variables](https://tailwindcss.com/docs/theme)

## 术语

| 术语 | 含义 |
| --- | --- |
| 桌面外壳 / 工作区 | 外壳包含桌面、任务栏和外壳浮层。工作区是扣除任务栏与安全区后的窗口坐标空间。 |
| 浮动窗口 / 移动端应用视图 | 前者为桌面可移动和缩放的窗口，后者在窄视口一次仅显示一个活动应用并贴合工作区。 |
| 激活窗口 / 键盘焦点 / 选择 | 三者分别是 WMKit 当前活动窗口、浏览器当前接受键盘输入的元素、用户选定的业务对象或快捷方式。 |
| 标题栏 / 工具栏 | 前者识别并控制窗口，后者承载当前应用或应用视图的动作。 |
| 检查器（Inspector） | 与当前对象关联、用于查看或修改其属性的应用内面板。 |
| 浮层 / 模态弹窗 | 浮层以锚点或窗口为参照显示附加界面。模态弹窗在当前 Web 桌面建立唯一的交互焦点范围。 |

## 规范索引

[02 设计 Token](02-design-tokens.md) · [03 桌面外壳](03-desktop-shell.md) · [04 窗口](04-window-guidelines.md) · [05 应用布局](05-application-layout.md) · [06 基础组件](06-component-guidelines.md) · [07 交互](07-interaction-guidelines.md) · [08 响应式](08-responsive-guidelines.md) · [09 主题](09-theme-guidelines.md)

当前工程采用 React、TypeScript、Tailwind CSS 4 与 WMKit。桌面外壳和应用的后续迭代以本规范为基线，普通浮动窗口的最小尺寸见 [02 设计 Token](02-design-tokens.md#尺寸与动效)。
