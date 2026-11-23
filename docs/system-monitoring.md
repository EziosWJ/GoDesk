# 系统监控

系统监控显示 goDesk 进程所在 Linux 主机的资源使用和端口占用。在 WSL 中运行时，数据来自 WSL 发行版内部，不读取 Windows 宿主机。

## 数据刷新

- 后端每秒采集 CPU、内存、磁盘用量和网卡收发速率，在内存中保留最近 60 个样本。服务重启后历史清空。
- 「概览」每 1 秒轮询指标接口。
- 「端口」只在标签页可见时每 5 秒轮询；离开后停止。
- 不提供历史落盘、告警或阈值通知。

## HTTP 接口

所有接口均需要操作者登录。响应为 JSON，并设置 `Cache-Control: no-store`。

| 方法与路径 | 成功响应 | 失败 |
| --- | --- | --- |
| `GET /api/v1/system/metrics` | `200` 指标快照 | `503` 采集尚未就绪；`401` 未登录 |
| `GET /api/v1/system/ports` | `200` 端口数组 | `500` 端口读取失败；`401` 未登录 |

失败响应为 `{"code":"...","message":"..."}`。`401` 由登录校验直接返回。

### 指标快照

```json
{
  "sampledAt": "2026-11-23T12:00:00Z",
  "platform": "Linux (WSL2)",
  "cpu": { "percent": 12.3, "perCore": [8.1, 16.5] },
  "memory": { "total": 8589934592, "used": 4294967296, "percent": 50 },
  "disks": [
    { "mountpoint": "/", "total": 1081101176832, "used": 118516396032, "percent": 11.6 }
  ],
  "network": [
    {
      "name": "eth0",
      "mac": "00:11:22:33:44:55",
      "ipv4": ["192.168.1.32"],
      "ipv6": ["fe80::1"],
      "rxRate": 1024.5,
      "txRate": 512
    }
  ],
  "series": {
    "cpu": [12.3, 11.8],
    "memory": [50, 49.5],
    "network": [{ "name": "eth0", "rx": [1024.5, 900], "tx": [512, 400] }]
  }
}
```

- `sampledAt` 为最近一次采样的 RFC 3339 时间；`platform` 标注运行环境，WSL 显示 `Linux (WSL2)`。
- 速率为字节/秒，容量为字节。
- `cpu`、`memory` 采集失败时为 `null`；`disks`、`network` 失败时为空数组。
- `series` 按时间从旧到新排列，最多 60 个点，长度与当前保留的采样数一致。某指标采集失败时，对应序列沿用上一个有效值，当前字段仍为 `null` 或空数组。
- 磁盘只返回真实文件系统（排除 tmpfs、proc、sysfs、overlay、iso9660 等伪文件系统或只读镜像），同一设备只保留一个挂载点。
- 网卡排除回环和未启用接口；只包含至少有一个地址的接口。

### 端口

```json
[
  { "protocol": "tcp", "address": "0.0.0.0", "port": 8080, "pid": 1234, "process": "godesk" },
  { "protocol": "tcp", "address": "::", "port": 22 },
  { "protocol": "udp", "address": "127.0.0.53", "port": 53 }
]
```

- `protocol` 为 `tcp` 或 `udp`；TCP 只包含 `LISTEN` 状态，UDP 只包含已绑定本地端口的 socket。
- 同时列出 IPv4 和 IPv6 地址；`address` 为本地绑定地址。
- goDesk 以普通主机账号运行时，可能无权读取其他账号进程的归属信息；此时省略 `pid` 和 `process`，前端显示「—」。
- 数组按端口升序返回；前端可再排序和筛选。

## 采集与权限

- 指标使用 `github.com/shirou/gopsutil/v4`。
- 端口使用 `gopsutil/net.Connections("all")`，过滤 `AF_INET` 与 `AF_INET6`；进程名读取 `/proc/<pid>/comm`。
- 不提升权限，不提供进程操作。
