# 05 · 文档同步与验证

Status: ready-for-human

同步系统监控相关文档，并完成构建与测试验证。

## 范围

- 新增 `docs/system-monitoring.md` 行为与接口契约。
- 更新 `.scratch/backend-v1/spec.md` 的监控条目。
- 更新根 `README.md` 和 `frontend/README.md` 中「仍使用示例逻辑」的说明。
- 运行 `go -C backend test ./...`、`pnpm --dir frontend lint`、`pnpm --dir frontend build`。

## 验收

- 文档中的接口、字段和降级行为与实现一致。
- 三条检查命令全部通过。

## Comments

- 2026-11-23：实现完成。新增 `docs/system-monitoring.md`，更新 backend-v1 spec、README 与 frontend README；三条检查命令全部通过，`make build` 生成 18M 单二进制并完成接口实测。
