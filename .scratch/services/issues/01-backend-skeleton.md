# 01 · 后端骨架与探测

Status: ready-for-human

实现 `backend/internal/services` 的最小接口、`none` 后端、启动探测和 `-service-backend` 参数，并接入 `main.run` 与 `httpserver.New`。

## 范围

- `Backend`、`Capabilities`、`Service` 和状态/动作枚举。
- 启动时探测一次：systemd（`/run/systemd/system` + `systemctl`）→ `none`。
- `-service-backend auto|systemd|none`，非法值启动报错；`none` 不阻止启动。
- 服务管理路由挂在 `RequireSession` 后。
- `GET /api/v1/services` 的聚合响应和空列表。

## 验收

- `none` 后端返回 `backend:"none"`、能力全 false、`services:[]`。
- 探测只发生一次，启动日志输出后端名称。
- `go -C backend test ./...` 通过。

## Comments

- 2026-11-23：实现完成。新增 `backend/internal/services` 的接口、`none` 后端和 `detect.go`；`main.go` 支持 `-service-backend`，`httpserver.New` 注册服务路由。handler 测试覆盖空后端和路由鉴权。
