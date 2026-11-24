# 系统监控与主机健康

系统监控显示 GoDesk 进程所在 Linux 主机的资源使用和端口占用。在 WSL 中运行时，数据来自 WSL 发行版内部，不读取 Windows 宿主机。

系统监控与主机健康状态中心职责不同：

- **系统监控**提供详细指标、趋势和端口信息，供进一步分析。
- **主机健康状态中心**消费同一份指标快照，按规则判断健康状态，并向桌面底栏提供摘要。
- **服务管理**负责服务详情和启停等操作，不由健康检查自动执行。

产品范围和健康判定原则见 [Host Health Center Spec](specs/host-health-center.md)。

## 数据刷新

### 当前已实现的系统监控

- 后端每秒采集 CPU、内存、磁盘用量和网卡收发速率，在内存中保留最近 60 个样本。服务重启后历史清空。
- 「概览」每 1 秒轮询指标接口。
- 「端口」只在标签页可见时每 5 秒轮询；离开后停止。
- 当前系统监控不提供历史落盘、告警通知或阈值配置。

### 主机健康状态中心目标行为（待实现）

- 后端复用同一采集器和快照，不重复采集已有指标。
- 健康规则在后端统一计算；底栏每 5 秒请求一次轻量状态摘要。
- 健康状态不返回 CPU、内存和网络的历史序列；详细趋势仍由 metrics 接口提供。
- 首版健康状态和异常持续时间保存在内存中，GoDesk 重启后重新判定，不提供持久化告警历史。
- 温度等低频硬件指标建议约每 5 秒采集一次，不随底栏轮询频率重复读取。

## HTTP 接口

所有接口均需要操作者登录。响应为 JSON，并设置 `Cache-Control: no-store`。

| 方法与路径 | 状态 | 成功响应 | 失败 |
| --- | --- | --- | --- |
| `GET /api/v1/system/metrics` | 已实现 | `200` 指标快照 | `503` 采集尚未就绪；`401` 未登录 |
| `GET /api/v1/system/ports` | 已实现 | `200` 端口数组 | `500` 端口读取失败；`401` 未登录 |
| `GET /api/v1/system/status` | 目标契约，待实现 | `200` 主机健康状态快照 | `503` 健康状态尚未就绪；`401` 未登录 |

失败响应为 `{"code":"...","message":"..."}`。健康状态接口中的单项采集失败应编码为对应检查的 `unknown`，不应使整个请求失败；只有健康引擎尚未产生首份快照时返回 `503`。

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
- 当前磁盘采集代码仅明确排除 `iso9660`、`squashfs` 和 `udf`。健康中心实现前必须补齐伪文件系统、临时文件系统、容器叠加层和只读镜像的过滤，并通过挂载点测试验证；不得把未过滤的虚拟挂载误判为真实磁盘空间告警。
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
- GoDesk 以普通主机账号运行时，可能无权读取其他账号进程的归属信息；此时省略 `pid` 和 `process`，前端显示「—」。
- 数组按端口升序返回；前端可再排序和筛选。

## 主机健康状态接口（目标契约）

> 本节定义 `GET /api/v1/system/status` 的目标契约，当前尚未实现。实现时必须以本节和 [Host Health Center Spec](specs/host-health-center.md) 为准，不得将目标契约误认为当前已有能力。

### 响应结构

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-24T01:00:00Z",
  "overall": "warning",
  "host": {
    "hostname": "node-01",
    "platform": "Linux",
    "architecture": "amd64",
    "uptimeSeconds": 1069200
  },
  "summary": {
    "total": 5,
    "healthy": 3,
    "warning": 1,
    "critical": 0,
    "unknown": 0,
    "unsupported": 1,
    "issueCount": 1
  },
  "checks": [
    {
      "id": "cpu",
      "category": "cpu",
      "label": "CPU",
      "status": "healthy",
      "applicable": true,
      "message": "CPU 使用率正常",
      "observedAt": "2026-11-24T01:00:00Z",
      "since": null,
      "value": 18.2,
      "unit": "percent",
      "details": {
        "logicalCores": 8,
        "loadAverage": [0.82, 1.15, 1.32]
      }
    },
    {
      "id": "memory",
      "category": "memory",
      "label": "内存",
      "status": "healthy",
      "applicable": true,
      "message": "可用内存充足",
      "observedAt": "2026-11-24T01:00:00Z",
      "since": null,
      "value": 62.0,
      "unit": "percent",
      "details": {
        "totalBytes": 8589934592,
        "usedBytes": 5315022202,
        "availableBytes": 3274912390,
        "availablePercent": 38.1,
        "swapUsedBytes": 0,
        "swapTotalBytes": 2147483648
      }
    },
    {
      "id": "disk:/",
      "category": "storage",
      "label": "根分区 /",
      "status": "warning",
      "applicable": true,
      "message": "根分区使用率达到警告阈值",
      "observedAt": "2026-11-24T01:00:00Z",
      "since": "2026-11-24T00:42:00Z",
      "value": 88.1,
      "unit": "percent",
      "details": {
        "mountpoint": "/",
        "totalBytes": 1081101176832,
        "usedBytes": 952450236416,
        "availableBytes": 128650940416,
        "inodeUsedPercent": 12.0
      }
    },
    {
      "id": "network:eth0",
      "category": "network",
      "label": "eth0",
      "status": "healthy",
      "applicable": true,
      "message": "默认路由接口运行正常",
      "observedAt": "2026-11-24T01:00:00Z",
      "since": null,
      "value": null,
      "unit": null,
      "details": {
        "linkUp": true,
        "isDefaultRoute": true,
        "ipv4": ["192.168.1.100"],
        "ipv6": [],
        "rxBytesPerSecond": 1258291,
        "txBytesPerSecond": 327680
      }
    },
    {
      "id": "temperature:cpu-package",
      "category": "temperature",
      "label": "CPU Package",
      "status": "unknown",
      "applicable": false,
      "message": "当前平台未提供可用于健康判定的温度阈值",
      "observedAt": "2026-11-24T01:00:00Z",
      "since": null,
      "value": null,
      "unit": "celsius",
      "details": {}
    }
  ]
}
```

字段约定：

| 字段 | 类型 | 约定 |
| --- | --- | --- |
| `schemaVersion` | integer | 响应结构版本，首版为 `1`。 |
| `generatedAt` | RFC 3339 string | 健康快照生成时间，统一使用 UTC 时间戳。 |
| `overall` | enum | `healthy`、`warning`、`critical`、`unknown`。 |
| `host` | object | GoDesk 所在 Linux 环境的信息；WSL 返回发行版内部信息。 |
| `summary` | object | 检查数量统计；`issueCount` 只统计 warning 与 critical。 |
| `checks` | array | 稳定 ID 的逐项检查结果，按类别和 ID 稳定排序。 |
| `checks[].status` | enum | `healthy`、`warning`、`critical`、`unknown`。 |
| `checks[].applicable` | boolean | 当前平台/配置是否适用该检查；不支持的可选能力为 `false`。 |
| `checks[].observedAt` | RFC 3339 string | 该项最近一次有效观测或判定时间。 |
| `checks[].since` | RFC 3339 string or null | 当前 warning/critical 状态开始时间；正常或不适用时为 `null`。 |
| `checks[].value` | number or null | 主要读数；复合数据放在 `details`。 |
| `checks[].unit` | string or null | `percent`、`celsius` 等机器可读单位。 |
| `checks[].details` | object | 按类别扩展的只读详细字段；字段定义随类别固定并版本化。 |

类别为 `cpu`、`memory`、`storage`、`network`、`temperature`、`system` 和后续可选的 `service`。动态检查项 ID 必须稳定：磁盘使用 `disk:<mountpoint>`，网卡使用 `network:<interface>`，温度传感器使用稳定传感器标识。不得使用数组下标作为 ID。

统计口径：

- `total` 包含所有返回检查项。
- `healthy`、`warning`、`critical`、`unknown` 统计适用检查项。
- `unsupported` 统计 `applicable=false` 的检查项；这类检查项的 `status` 固定为 `unknown`，但不参与整体状态聚合。
- `issueCount` 为适用检查项中 warning 与 critical 的数量，不包含 unknown 和 unsupported。
- `overall` 按 `critical > warning > unknown > healthy` 聚合适用检查项；没有适用检查项时为 `unknown`。
- 采集失败的适用检查必须返回 `unknown` 和可读 `message`；不得沿用旧读数并继续标记 healthy。旧值可以作为诊断信息，但必须明确标识过期。
- `since` 与状态转换信息首版只保存在内存中，GoDesk 重启后可以重新开始计时。

网络契约：

- `rxBytesPerSecond`、`txBytesPerSecond` 单位为字节/秒；零流量不代表链路异常。
- 默认只对默认路由接口做健康判断；其他接口可以作为信息项展示。
- 无默认路由时不得默认判定互联网断开；网关或外网探测必须由用户显式配置，且分别呈现探测目标。
- 不能将浏览器的网络状态当作 Linux 网卡状态。

温度契约：

- `value` 使用摄氏度。
- 优先使用 `hwmon` 或 thermal 子系统暴露的传感器及其阈值。
- 没有可信阈值时可以展示读数，但不得自动生成 warning/critical；传感器不可用时返回不适用或采集未知，并说明原因。

错误与连接语义：

- `200`：返回最新健康快照，即使其中某些检查为 `unknown`。
- `503`：健康引擎尚未产生第一份快照，错误码建议为 `health_unavailable`。
- `401`：未登录，由现有会话认证中间件返回。
- 浏览器请求超时、网络错误或连续失败属于前端连接状态，不是该 API 的主机健康结果。
- 所有响应设置 `Cache-Control: no-store`。

## 采集与权限

- 现有 CPU、内存、磁盘和网络指标使用 `github.com/shirou/gopsutil/v4`。
- 端口使用 `gopsutil/net.Connections("all")`，过滤 `AF_INET` 与 `AF_INET6`；进程名读取 `/proc/<pid>/comm`。
- 健康检查优先复用现有采集结果；温度等能力只读 Linux sysfs/procfs。
- 不隐式提升权限，不提供进程操作。权限不足或平台不支持时按检查项语义返回 unknown/unsupported。
