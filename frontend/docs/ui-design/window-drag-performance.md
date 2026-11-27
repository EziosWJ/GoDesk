# 窗口拖动流畅度调研

建议先收窄 React 对窗口状态的订阅，让窗口坐标每帧更新时只走现有 WMKit 拖动路径。再用同一条轨迹比较磁吸阈值，最后针对贴边预览检查绘制和合成开销。三项分别对应全桌面渲染、指针与窗口位置的偏差、边缘预览的渲染成本。[goDesk 桌面入口](../../src/App.tsx) · [窗口规范](04-window-guidelines.md) · [Chrome 渲染架构](https://developer.chrome.com/docs/chromium/renderingng-architecture)

## 当前拖动路径

- **WMKit 已经按帧处理位置。** 锁定版本为 `0.13.1`。标题栏捕获指针，`pointermove` 更新最新坐标，`requestAnimationFrame` 合并待处理移动，`wm.move` 在坐标确实变化时更新状态。DOM 绑定器以 `translate3d` 移动窗口，仅在宽高变化时写入尺寸。拖动期间已有 `will-change: transform`，结束时会清除。这条路径可在本地安装包的 `dist/chunk-6X3ETH3M.js` 中通过 `createDragStarter`、`move` 和 `syncWindow` 复核。[依赖锁文件](../../pnpm-lock.yaml) · [WMKit 官方仓库](https://github.com/Surdeddd/wmkit) · [HTML 动画帧规范](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#animation-frames)
- **每次位置变化都会使 `App` 的 React 快照失效。** WMKit 的 `dist/react.js` 中，`useWmState` 以 `wm.getState` 作为 `useSyncExternalStore` 的快照。`App` 读取整个状态后重新生成 `running`、窗口子树和桌面快捷方式，并把完整 `windows` 传给终端会话管理。React 使用 `Object.is` 判断快照是否变化，WMKit 更新位置会换掉快照引用。拖动时的根提交计数验证了这一开销值得优先拆除。[goDesk 桌面入口](../../src/App.tsx) · [WMKit React 适配器文档](https://wmkit.vercel.app/docs/adapters.html#react) · [React 外部存储订阅](https://react.dev/reference/react/useSyncExternalStore#parameters)
- **磁吸会影响跟手感。** 当前阈值为 `10` CSS px。WMKit 每次处理拖动时会遍历工作区及可参与磁吸的其他窗口，其 `magnetize` 分别计算 X、Y 轴最近边缘，沿某轴吸附时无需另一轴存在重叠。因此，即使在桌面中央，窗口经过另一窗口的对齐线时也可能短暂停住，超出阈值后再回到原来的拖动轨迹上。此时帧间隔仍可能正常。贴边分屏和顶部最大化另由指针所在区域决定。磁吸实现可在安装包的 `dist/chunk-RPQVZXMR.js` 中复核。[goDesk 工作区配置](../../src/App.tsx) · [窗口规范](04-window-guidelines.md) · [WMKit 官方仓库](https://github.com/Surdeddd/wmkit)
- **边缘预览涉及额外渲染工作。** 分屏预览使用 `backdrop-filter: blur(10px) saturate(135%)`，并过渡宽、高、变换和透明度。滤镜会处理预览后方的内容，宽高变化可能触发布局。实际成本取决于场景和设备，可在靠边轨迹中用 Chrome 的 Main、Raster、GPU 和 Frames 记录验证。[预览样式](../../src/styles/window.css) · [CSS Filter Effects 规范草案](https://drafts.csswg.org/filter-effects-2/#BackdropFilterProperty) · [Chrome Performance 面板](https://developer.chrome.com/docs/devtools/performance/reference)

## 本地基线

使用生产构建、模拟后端和 Playwright MCP 的 Chromium，视口为 `1440 × 900` CSS px。打开系统设置、文件管理器和图标管理，用 Playwright 鼠标按下图标管理标题栏，让 WMKit 捕获指针。页面随后以 `8 ms` 为目标间隔向标题栏派发带同一指针 ID 的 `pointermove`，采样约 `1.8 s`，最后用 Escape 复位。[Playwright 鼠标 API](https://playwright.dev/docs/api/class-mouse) · [W3C Pointer Events](https://www.w3.org/TR/pointerevents3/#pointer-capture) · [Chrome CPU 降速接口](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setCPUThrottlingRate)

| CPU 降速 | 合成指针事件 | rAF 间隔数 | rAF 间隔 P95 | 采到的窗口 transform 更新 | transform 更新间隔 P95 | React 根提交 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1× | 197 | 108 | 16.8 ms | 96 | 16.8 ms | 105 |
| 4× | 50 | 56 | 66.7 ms | 36 | 83.5 ms | 40 |

4× 条件下有 33 个 rAF 间隔超过 `25 ms`。降速也拖慢了页面内派发事件的定时器，两组实际输入频率不同。`transform` 更新计数表示采样时检测到的位置变化，rAF 间隔表示回调节奏，浏览器呈现情况需要通过 Frames 轨道确认。这组数据用于定位 React 根提交和主线程延迟，归因及实际设备上的流畅度仍需录制验证。[rAF 回调时机](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame) · [Chrome Frames 轨道说明](https://developer.chrome.com/docs/devtools/performance/reference#frames)

## 建议的实施顺序

1. **只订阅 React 参与渲染的窗口字段。** 最小改动是在 `App` 用一次带选择器的外部存储订阅，取 `focusedId` 和窗口列表的 `id`、`openedSeq`、`title`、`stage`、`meta`。纯位置变化时复用上一次的选择结果，保留从 `state.windows` 取出的顺序和 `openedSeq` 键，避免焦点切换引发 DOM 重排和 iframe 重载。可用 React 官方 `useSyncExternalStoreWithSelector` 比较选择结果，或用 `useSyncExternalStore` 搭配返回稳定引用的快照。单独改为 `useWmWindow` 仍会订阅整条窗口对象，包括 `bounds`。后续仅在录制表明还有明显成本时，再把任务栏和窗口内容的订阅下移。[goDesk 桌面入口](../../src/App.tsx) · [WMKit 适配器约定](https://wmkit.vercel.app/docs/adapters.html) · [React 外部存储订阅](https://react.dev/reference/react/useSyncExternalStore) · [React 选择器实现](https://github.com/react/react/blob/main/packages/use-sync-external-store/src/useSyncExternalStoreWithSelector.js)

   `AppWindow` 的 React 渲染需要标题、阶段和窗口实例标识。任务栏需要聚焦、标题、最小化和窗口列表。终端会话管理可用窄类型读取会话对应的窗口是否存在、`stage` 和 `meta.clientId`，终端内容仍需响应 `meta.session`、`meta.clientId`、`meta.controlRequest` 与聚焦变化。打开、关闭、显示桌面和缩放后记忆尺寸可沿用当前 `wm.getState()` 与关闭事件读取的实时数据。[窗口壳](../../src/AppWindow.tsx) · [终端会话管理](../../src/TerminalSessions.tsx) · [窗口操作与尺寸记忆](../../src/App.tsx)

2. **用慢速横向和对角线拖动比较磁吸。** 对比当前 `10 px`、`4–6 px` 试验值与 `magnetism: false`，轨迹覆盖桌面中央的窗口对齐线及工作区边缘。同步记录预期窗口位置（指针坐标减去初始抓取偏移）与实际位置，避开视口钳制范围观察偏差和离开阈值时的跳变。`useDesktop` 在首次渲染捕获配置，每组比较都应重新加载页面。贴边分屏与顶部最大化由 `snap` 配置独立控制。[goDesk 工作区配置](../../src/App.tsx) · [WMKit React 适配器文档](https://wmkit.vercel.app/docs/adapters.html#react)

3. **仅在贴边场景掉帧时简化预览。** 先用相同轨迹对比现有预览和保留半透明强调色、轮廓的纯色预览。若轨迹频繁切换区域且记录显示布局开销，再比较几何立即更新、只过渡透明度的版本。通过 Paint flashing、Layer borders 和 Performance 记录核对收益。WMKit 已有拖动期间的图层提示，全窗口常驻 `will-change` 会增加浏览器资源占用，应以录制结果决定是否需要进一步调整。[预览样式](../../src/styles/window.css) · [Chrome 渲染调试工具](https://developer.chrome.com/docs/devtools/rendering/performance) · [CSS `will-change` 规范](https://www.w3.org/TR/css-will-change-1/#using)

## 验证方式

- **重复同一交互。** 用相同生产构建方式、视口、初始窗口布局和输入路径对比改前改后。跑桌面中央、经过窗口对齐线和贴边三条轨迹，并用真实鼠标复测文件列表、终端或扩展 iframe 等内容较重的窗口。分别记录 1× 与 4× 条件，每种重复至少 5 次并记下实际输入事件数。用目标设备、浏览器和刷新率的真实输入复核，60 Hz 的单帧预算约 `16.7 ms`，120 Hz 约 `8.3 ms`。[Playwright 鼠标 API](https://playwright.dev/docs/api/class-mouse) · [浏览器 rAF 与刷新率](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame) · [Chrome CPU 降速接口](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setCPUThrottlingRate)
- **看帧间隔和根渲染是否随拖动密度而变化。** 在 Chrome Frames 轨道看部分呈现、掉帧及连续掉帧段，记录 rAF 和实际窗口位置更新间隔的 P95。React 根提交用 React DevTools 或启用 profiling 的生产构建单独核对，以免采样开销影响呈现数据。第一阶段的通过条件是，稳定拖动时单纯的 `x/y` 变化对 `App` 增加零次提交，浏览器帧记录在同等压力下改善。若只达到前一项，继续沿 Performance 记录里的主线程、Raster 或 GPU 活动定位。[Chrome Frames 轨道说明](https://developer.chrome.com/docs/devtools/performance/reference#frames) · [React Profiler](https://react.dev/reference/react/Profiler)
- **复测窗口行为。** 检查聚焦和任务栏状态、最小化与还原、最大化和分屏窗口拖出后还原、Escape 取消、缩放尺寸记忆、关闭并重新打开同 ID 窗口，以及终端改名和控制权切换。用浏览器鼠标或触控输入从标题栏拖过扩展 iframe，核对拖动连续、松手结束、拖动后 iframe 仍可接收输入。页面定向派发的合成事件适合测应用自身的更新频率，跨 iframe 的指针捕获需要单独操作验证。[窗口规范](04-window-guidelines.md) · [扩展 iframe 入口](../../src/extensions/ExtensionWindow.tsx) · [W3C Pointer Events](https://www.w3.org/TR/pointerevents3/#pointer-capture)
