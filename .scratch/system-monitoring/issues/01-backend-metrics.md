# 01 · 后端指标采集与接口

Status: ready-for-human

实现 `backend/internal/monitor` 的指标采集器、`GET /api/v1/system/metrics`，并接入 `main.run` 与 `httpserver.New`。

## 范围

- 每秒采集 CPU（总/每核）、内存、磁盘用量、网卡地址与收发速率。
- 内存环形缓冲保留最近 60 个样本；首样本前接口返回 `503`。
- 采集失败按指标降级为 `null` 或空数组，其余字段照常返回。
- 使用 `gopsutil/v4`；磁盘只返回当前用量；网卡排除回环和未启用接口。
- 采集器随进程退出关闭。

## 验收

- `GET /api/v1/system/metrics` 需要登录，返回 `docs/system-monitoring.md` 定义的快照。
- 单元测试覆盖采集、序列长度和 HTTP 200/503。
- `go -C backend test ./...` 通过。

## Comments

- 2026-11-23：实现完成。新增 `backend/internal/monitor` 的采集器与 `/api/v1/system/metrics`；`go test ./...` 通过，实测 WSL2 返回 CPU/内存/磁盘/网卡数据与 60 秒序列。
