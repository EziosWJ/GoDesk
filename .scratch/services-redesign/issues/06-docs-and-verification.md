# 06 · 文档与验证

Status: ready-for-human

## 范围

- `docs/services.md`：新增详情端点（字段、错误、null 规则、不调用 List 的说明）与前端行为更新。
- `frontend/README.md`：修正「监控、服务和托盘使用示例数据」的过期描述。
- 检查 `App.css` 无遗留服务样式；确认 `.service-dialog` 仍被终端会话/登出复用。
- 执行完整验收：手工清单 + `go -C backend test ./...` + `pnpm --dir frontend lint` + `pnpm --dir frontend build` + `make build`。
- 在各 ticket 的 Comments 记录完成情况。

## 验收

- 文档与实现一致；构建与测试全部通过；手工验收清单无遗漏。

## Comments

- 2026-11-23：验证完成。更新 `docs/services.md`（详情端点/UI 行为/限制）与 `frontend/README.md`；`go -C backend test ./...`、`pnpm --dir frontend lint`、`pnpm --dir frontend build`、`make build` 通过；Chrome headless 端到端验证通过（202 个服务、明暗主题、串行模式、确认框、日志搜索）。未执行真实启停动作（仅验证禁用态与确认框取消），避免影响主机服务。
