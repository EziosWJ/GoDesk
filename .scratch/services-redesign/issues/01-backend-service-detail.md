# 01 · 后端单服务详情端点

Status: ready-for-human

新增 `GET /api/v1/services/{unit}`，返回详情网格所需的单服务字段。

## 范围

- `backend/internal/services/services.go`：`ServiceDetail` 类型（name、state、stateDetail、bootState、mainPid、memoryBytes、cpuUsageNs、activeEnterTimestamp、fragmentPath），`Backend` 接口增加 `Detail`。
- `backend/internal/services/systemd.go`：`systemctl show -p ActiveState,SubState,UnitFileState,MainPID,MemoryCurrent,CPUUsageNSec,ActiveEnterTimestamp,FragmentPath -- <unit>`；`LC_ALL=C`、绝对路径、不经 shell、10s 超时；null/空值规则按 spec。
- 状态与开机状态复用现有映射。
- `backend/internal/services/none.go`：返回 not_found。
- `backend/internal/services/http.go`：路由、`ValidUnit` 校验、错误映射（400/403/404/422/504）、`Cache-Control: no-store`。
- `httpserver` 路由注册。

## 验收

- running / completed / stopped / failed / 未加载单元均返回正确字段。
- `[not set]`、0 PID、超范围数字 → `null`；空时间戳/路径 → `""`。
- 单元不存在 404；非法单元名 400；权限 403；超时 504。
- 不调用 `Backend.List`。
- `go -C backend test ./...` 通过，新增解析与 handler 测试。

## Comments

- 2026-11-23：实现完成。`ServiceDetail` 类型与 `Backend.Detail`、`systemctl show` 解析、`GET /api/v1/services/{unit}` 路由（不调用 `List`）、错误映射与测试均已落地；`go -C backend test ./...` 通过，真实 systemd 集成测试通过。
