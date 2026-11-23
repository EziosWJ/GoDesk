# 06 · 文档与验证

Status: ready-for-human

补齐 ADR、功能文档、README/GLOSSARY，并完成构建与端到端验证。

## 范围

- `docs/adr/0007-detect-service-backend-at-startup.md`。
- `docs/services.md`：行为、HTTP 契约、权限、限制和未来后端。
- README 功能列表、`-service-backend` 参数和服务管理章节。
- GLOSSARY 增加服务后端、能力声明、可用动作。
- 验证：`go -C backend test ./...`、`pnpm --dir frontend lint`、`pnpm --dir frontend build`、`make build`。

## 验收

- 文档与实现一致，包含权限和已知限制。
- 只读端到端验证：systemd 后端返回真实服务，`none` 后端返回空列表，未登录返回 401。
- 完整构建生成嵌入前端的二进制。

## Comments

- 2026-11-23：实现完成。ADR、功能文档和 README/GLOSSARY 已更新。`go test ./...`、前端 lint/类型检查/构建、`make build` 全部通过；本机 systemd 259 实测 202 个服务、ssh.service 日志和 `none` 后端空状态均正确。
