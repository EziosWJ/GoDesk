# 04 · 前端详情与动作

Status: ready-for-human

详情头部、键值网格、动作与确认流程。

## 范围

- 接入 `servicesApi.detail(unit)`；选中变化、列表刷新、动作成功后拉取。
- 头部：unit 名（等宽、可聚焦）+ 状态徽章 + 动作区。
- 动作：启动/停止主按钮 + 重启 +「开机自启」开关；可用性依据后端 `actions`，不可用动作**禁用并提示原因**（原生 title 即可），不隐藏。
- 确认：停止/重启/禁用走共享 `.service-dialog` 模式；启动/启用直接执行。
- busy：进行中禁用动作并内联提示；失败内联 `role="alert"`；401 整页重载。
- tabs：详情 / 日志（`capabilities.logs=false` 时无日志页）；保持 ARIA tab 语义。
- 详情三组：概述（描述、状态、原始状态、开机自启）、运行（主 PID、内存、CPU 累计时间、启动时间）、文件（unit 文件路径）；空值「—」；含加载与错误状态。

## 验收

- 详情字段与 `systemctl show` 一致；空值显示「—」。
- 运行中禁用「启动」、未运行禁用「停止/重启」、masked 单元的原因提示正确；static/masked/runtime/not_applicable 的自启开关禁用并提示。
- 停止/重启/禁用弹确认；确认后刷新列表、详情与（若打开）日志。
- busy 期间不可连点；失败提示不丢失当前上下文。
- `pnpm --dir frontend lint` 与 `pnpm --dir frontend build` 通过。
