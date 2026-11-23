# 系统监控

为「系统监控」窗口补齐真实数据：主机资源概览与端口占用视图。

## 目标

在单台 Linux 主机、一位操作者的前提下，提供：

- 资源概览：CPU（总使用率与每核）、内存、磁盘用量、网卡地址与收发速率，显示最近 60 秒趋势。
- 端口占用：TCP 监听与 UDP 绑定端口，含 IPv4/IPv6 地址，尽力标注归属进程名与 PID。
- 数据来源是 goDesk 进程所在的 Linux 环境；在 WSL 中运行时即 WSL 发行版内部，不读取 Windows 宿主机。

## 不做

- 告警、阈值和通知。
- 历史数据落盘或任意时间范围查询。
- 通用进程列表、进程操作（kill/renice）。
- 磁盘 I/O、load average、温度、GPU、SMART、容器状态。
- 远程多主机和 Windows 宿主机指标。

## 设计决策

- 采集频率 1 秒，后端内存环形缓冲保留 60 个样本，前端轮询。
- 指标接口每 1 秒轮询；端口接口按需扫描，仅「端口」标签可见时每 5 秒轮询。
- 复用现有 JWT Cookie 鉴权，不新增角色。
- 端口列表完整展示；无权限读取归属进程时显示「—」，不提升权限。
- 磁盘返回当前用量，不保留趋势；网卡排除回环和未启用接口。
- 采集失败降级：字段为 `null` 或空数组；首个样本前指标接口返回 `503`；端口整体失败返回 `500`。
- 前端不引入图表库，沿用内联 SVG sparkline 和原生 `meter`。

## 接口

行为与 JSON 形状见 [系统监控契约](../../docs/system-monitoring.md)。

- `GET /api/v1/system/metrics`
- `GET /api/v1/system/ports`

## 实现

- `backend/internal/monitor`：采集器、端口扫描和 HTTP 处理。
- 指标使用 `github.com/shirou/gopsutil/v4`；端口使用 `net.Connections("all")`（过滤 `AF_INET`/`AF_INET6`），进程名读取 `/proc/<pid>/comm`。
- 采集器在 `main.run` 中启动，随进程退出关闭。
- 前端 `src/monitor.ts` 封装接口；`SystemMonitor.tsx` 提供「概览 / 端口」标签页。

## 验收

- 登录后打开「系统监控」，概览显示真实 CPU/内存/磁盘/网卡数据，每秒更新；60 秒趋势连续。
- 端口页列出本机 TCP 监听和 UDP 绑定端口，权限不足的进程显示「—」，每 5 秒更新；离开端口页停止轮询。
- 未登录访问两个接口返回 `401`；首个样本前指标接口返回 `503`；采集异常时页面显示重试状态而不崩溃。
- `go -C backend test ./...`、`pnpm --dir frontend lint`、`pnpm --dir frontend build` 通过。
