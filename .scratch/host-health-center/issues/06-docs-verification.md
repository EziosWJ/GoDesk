# 06 · 文档与验证

Status: ready-for-human

同步文档并完成 V1 验证。

## 范围

- 更新 `docs/system-monitoring.md`：状态接口与指标扩展标记为已实现，保留契约语义。
- 更新 `docs/specs/host-health-center.md` 的实施状态。
- 更新 `frontend/docs/ui-design/03-desktop-shell.md`：健康入口不再是目标设计。
- 更新 `README.md` 当前功能。
- 按 spec 第 9、12 节执行验证：`go -C backend test ./...`、`pnpm --dir frontend lint`、`pnpm --dir frontend build`。

## 验收

- 三条命令全部通过。
- 已知取舍与 V2/V3 范围保持不变。

## Comments

- 2026-11-24：实现完成。已同步 `docs/system-monitoring.md`、`docs/specs/host-health-center.md`、`frontend/docs/ui-design/03-desktop-shell.md` 与 `README.md`。`go -C backend test ./...`、`pnpm --dir frontend lint`、`pnpm --dir frontend build`、`make build` 均通过；另用无头 Chrome 完成明暗主题、320px、连接中断/恢复与面板交互验证。