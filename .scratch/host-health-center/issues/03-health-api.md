# 03 · 健康状态 API

Status: ready-for-human

实现 `GET /api/v1/system/status`，读取健康引擎最新只读快照。

## 范围

- 经过现有操作者会话认证，`401` 由现有中间件返回。
- `Cache-Control: no-store`，JSON，无副作用。
- 健康引擎尚未产生首份快照时返回 `503`，错误码 `health_unavailable`；首份快照后即使全部检查未知也返回 `200`。
- 顶层 `stale` 按 `now - generatedAt > 15s` 计算。
- 单项采集失败编码为对应检查的 `unknown`，不使整个请求失败。
- 接入 `httpserver.New` 与 `main.run`。
- 补 handler 测试：`200`、`401`、`503`、`no-store`、单项失败隔离、`generatedAt` 格式。

## 验收

- `go -C backend test ./...` 通过。

## Comments

- 2026-11-24：实现完成。`GET /api/v1/system/status` 接入会话认证并设置 `Cache-Control: no-store`；首份快照前返回 `503 health_unavailable`。handler 测试覆盖 200/401/503、单项失败、`generatedAt` 格式与顶层 `stale`；`httpserver.New` 与 `main.run` 已接入。真实服务端到端验证通过。