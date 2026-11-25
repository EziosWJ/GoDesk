# 系统监控与主机健康

系统监控显示 GoDesk 进程所在 Linux 主机的资源使用和端口占用。在 WSL 中运行时，数据来自 WSL 发行版内部，不读取 Windows 宿主机。

系统监控与主机健康状态中心职责不同：

- **系统监控**提供详细指标、趋势和端口信息，供进一步分析。
- **主机健康状态中心**消费同一份指标快照，按规则判断健康状态，并向桌面底栏提供摘要。
- **服务管理**负责服务详情和启停等操作，不由健康检查自动执行。

产品范围、状态语义和健康判定原则见 [Host Health Center Spec](specs/host-health-center.md)。

## 数据刷新

### 当前已实现的系统监控

- 后端每秒采集 CPU、内存、磁盘用量与 inode、网卡收发速率、链路状态和默认路由信息，在内存中保留最近 60 个样本。服务重启后历史清空。
- 「概览」每 1 秒轮询指标接口。
- 「端口」打开时立即以管理员身份读取监听，随后每 5 秒轮询。离开标签页后停止轮询。
- 主机健康引擎消费同一份采集快照，每秒评估 CPU、内存、磁盘和默认路由接口，并维护持续判定与恢复迟滞；底栏每 5 秒轮询健康状态接口。
- 当前系统监控不提供历史落盘、告警通知或阈值配置。

### 主机健康状态中心行为

- 后端复用同一采集器和快照，不重复采集已有指标。
- 健康规则在后端统一计算；底栏每 5 秒请求一次轻量状态摘要。
- 健康引擎按采集周期评估检查项，并自行维护 CPU 5 分钟、内存 2 分钟等持续判定窗口；metrics 保留的 60 点序列只用于展示，不能作为健康判定的完整历史。
- 健康状态不返回 CPU、内存和网络的历史序列；详细趋势仍由 metrics 接口提供。
- 首版健康状态和异常持续时间保存在内存中，GoDesk 重启后重新判定，不提供持久化告警历史。
- 温度等低频硬件指标约每 5 秒采集一次，不随底栏轮询频率重复读取。

## HTTP 接口

所有接口均需要操作者登录。响应为 JSON，并设置 `Cache-Control: no-store`。

| 方法与路径 | 状态 | 成功响应 | 失败 |
| --- | --- | --- | --- |
| `GET /api/v1/system/metrics` | 已实现 | `200` 指标快照 | `503` 采集尚未就绪；`401` 未登录 |
| `GET /api/v1/system/ports` | 已实现 | `200` 端口数组 | `403` 管理员权限不可用；`500` 读取失败 |
| `GET /api/v1/system/ports/detail` | 已实现 | `200` 进程树、归属服务与关联监听 | `403` 管理员权限不可用；`409` 监听目标已变化 |
| `GET /api/v1/system/ports/logs` | 已实现 | `200` `{"lines":[...]}` | `409` 监听目标已变化；`500` journal 不可用 |
| `POST /api/v1/system/ports/stop` | 已实现 | `204` 停止命令已执行 | `403` 管理员权限不可用；`409` 目标已变化或仅支持查看 |
| `GET /api/v1/system/status` | 已实现 | `200` 主机健康状态快照 | `503` 健康状态尚未就绪；`401` 未登录 |

失败响应为 `{"code":"...","message":"..."}`。健康状态接口中的单项采集失败应编码为对应检查的 `unknown`，不应使整个请求失败；只有健康引擎尚未产生首份快照时返回 `503`。

### 指标快照

```json
{
  "sampledAt": "2026-11-23T12:00:00Z",
  "platform": "Linux (WSL2)",
  "cpu": { "percent": 12.3, "perCore": [8.1, 16.5] },
  "memory": { "total": 8589934592, "used": 4294967296, "available": 3274912390, "percent": 50 },
  "disks": [
    { "mountpoint": "/", "total": 1081101176832, "used": 118516396032, "percent": 11.6, "inodeUsedPercent": 12.0 }
  ],
  "network": [
    {
      "name": "eth0",
      "mac": "00:11:22:33:44:55",
      "ipv4": ["192.168.1.32"],
      "ipv6": ["fe80::1"],
      "rxRate": 1024.5,
      "txRate": 512,
      "linkUp": true,
      "isDefaultRoute": true
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

#### 健康中心指标扩展

健康引擎只消费采集器快照，不再自行读取 CPU、内存、磁盘或网络计数器。指标快照包含以下扩展字段；已有字段的名称和语义不变。

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `memory.available` | 整数，字节 | 计算可用内存比例；健康值使用 `100 - available/total`。 |
| `disks[].inodeUsedPercent` | number 或 null | inode 检查；文件系统不提供 inode 统计时为 `null`。 |
| `network[].linkUp` | boolean | 链路状态，用于区分断链与无地址。 |
| `network[].isDefaultRoute` | boolean | 标记承载默认路由的接口，供健康引擎选择检查对象。 |

这些字段随健康中心 V1 实现，metrics 响应在原有字段基础上返回这些扩展。健康引擎需要的 5 分钟持续窗口由健康层自行保留，不扩大 metrics 的 60 点展示序列。

为支持网络判定，默认路由接口即使 `linkUp=false` 或没有可用地址，也必须出现在 metrics 的 `network` 数组中；其余接口维持现有过滤。metrics JSON 不必暴露内部错误，但采集器的进程内快照必须区分「空结果」和「采集失败」（例如磁盘、网络枚举错误），健康引擎据此生成 `collect_failed`，而不是误判为 `not_supported`。

### 端口

```json
[
  {
    "protocol": "tcp",
    "address": "0.0.0.0",
    "port": 8080,
    "owners": [
      { "pid": 1234, "process": "worker", "startTicks": 48392 },
      { "pid": 1235, "process": "worker", "startTicks": 48395 }
    ]
  },
  {
    "protocol": "udp",
    "address": "127.0.0.53",
    "port": 53,
    "owners": [],
    "unknownOwner": true
  }
]
```

- TCP 只包含监听 socket，UDP 包含已绑定本地端口的 socket。IPv4 和 IPv6 都按协议、监听地址和端口分组。多个进程共享同一个 socket 时，列出所有可识别的持有进程。组内存在找不到进程的 socket 时，返回 `unknownOwner: true`。
- 列表、进程树、日志和停止操作都使用管理员权限。root 直接执行，普通账号沿用 [GoDesk 免密 sudo](privileges.md)。权限不可用返回 `403 admin_unavailable`。
- 详情和日志通过查询参数传入 `protocol`、`address`、`port`、`pid` 和 `startTicks`。进程树显示选中进程的父级链和子孙，每个节点含进程名、PID、启动时刻和运行用户。归属于 systemd 系统服务时，详情另返回 `unit` 与当前可识别的其他监听 `otherPorts`。停止涉及 GoDesk 时返回 `stopsDesk: true`。
- 日志按同一系统服务单元读取，普通进程限定为当前开机及该进程本次启动以来的记录。服务日志请求同时传入详情中的 `unit`。最多返回最近 500 行，界面可手动刷新。进程退出后，已加载的详情仍可查看。
- 停止使用 JSON 提交与详情相同的目标字段。若详情返回 `unit`，停止请求也要带上 `unit`。后端重新验证监听关系、进程实例和服务归属。系统服务复用服务管理的停止命令。普通进程通过 Linux pidfd 发送一次 `SIGTERM`。PID 1 只提供查看。
- 停止后立即刷新。仍由其他进程或 socket 激活单元持有的端口会继续显示。API 在认证失败时返回 `401`，目标参数无效时返回 `400`，操作超时时返回 `504`。

## 主机健康状态接口

> 本节定义 `GET /api/v1/system/status` 的契约，V1 已实现。产品范围、状态语义与阈值规则见 [Host Health Center Spec](specs/host-health-center.md)。

该接口与无需登录的 `GET /healthz` 职责不同：`/healthz` 只报告 GoDesk 进程与 SQLite 是否存活；本接口报告被管理主机的健康状态，必须经过操作者会话认证。

### 响应结构

以下为 V1 示例，包含 CPU、内存、一个挂载点和一个默认路由接口。V1 不返回温度检查；温度、Swap、Load Average 等可选检查在 V2 实现后按相同结构追加。

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-24T01:00:00Z",
  "stale": false,
  "overall": "warning",
  "host": {
    "hostname": "node-01",
    "platform": "Linux (WSL2)",
    "architecture": "amd64",
    "uptimeSeconds": 1069200
  },
  "summary": {
    "total": 4,
    "healthy": 3,
    "warning": 1,
    "critical": 0,
    "unknown": 0,
    "notApplicable": 0,
    "issueCount": 1
  },
  "checks": [
    {
      "id": "cpu",
      "category": "cpu",
      "label": "CPU",
      "status": "healthy",
      "applicable": true,
      "reason": "ok",
      "message": "CPU 使用率正常",
      "observedAt": "2026-11-24T01:00:00Z",
      "since": null,
      "stale": false,
      "value": 18.2,
      "unit": "percent",
      "thresholds": { "warning": 85, "critical": 95 },
      "details": { "logicalCores": 8 }
    },
    {
      "id": "memory",
      "category": "memory",
      "label": "内存",
      "status": "healthy",
      "applicable": true,
      "reason": "ok",
      "message": "可用内存充足",
      "observedAt": "2026-11-24T01:00:00Z",
      "since": null,
      "stale": false,
      "value": 61.9,
      "unit": "percent",
      "thresholds": { "warning": 85, "critical": 95 },
      "details": {
        "totalBytes": 8589934592,
        "usedBytes": 5315022202,
        "availableBytes": 3274912390,
        "availablePercent": 38.1
      }
    },
    {
      "id": "disk:/",
      "category": "storage",
      "label": "根分区 /",
      "status": "warning",
      "applicable": true,
      "reason": "threshold_warning",
      "message": "根分区容量使用率达到警告阈值",
      "observedAt": "2026-11-24T01:00:00Z",
      "since": "2026-11-24T00:42:00Z",
      "stale": false,
      "value": 88.1,
      "unit": "percent",
      "thresholds": { "warning": 85, "critical": 95 },
      "details": {
        "mountpoint": "/",
        "dimension": "capacity",
        "capacityUsedPercent": 88.1,
        "inodeUsedPercent": 12.0,
        "totalBytes": 1081101176832,
        "usedBytes": 952450236416,
        "availableBytes": 128650940416
      }
    },
    {
      "id": "network:eth0",
      "category": "network",
      "label": "eth0",
      "status": "healthy",
      "applicable": true,
      "reason": "ok",
      "message": "默认路由接口运行正常",
      "observedAt": "2026-11-24T01:00:00Z",
      "since": null,
      "stale": false,
      "value": null,
      "unit": null,
      "thresholds": null,
      "details": {
        "interface": "eth0",
        "linkUp": true,
        "isDefaultRoute": true,
        "ipv4": ["192.168.1.100"],
        "ipv6": [],
        "rxBytesPerSecond": 1258291,
        "txBytesPerSecond": 327680
      }
    }
  ]
}
```

V2 可选检查沿用相同结构。例如传感器可读但没有可信阈值时，温度检查返回 `applicable=false`、`status=unknown`、`reason=no_threshold`，仍保留读数和传感器信息，但不参与整体状态聚合。

### 字段约定

| 字段 | 类型 | 约定 |
| --- | --- | --- |
| `schemaVersion` | integer | 响应结构版本，首版为 `1`。新增可选字段不升级；删除字段、改名或改变既有语义必须升级。 |
| `generatedAt` | RFC 3339 string | 健康快照生成时间，统一使用 UTC 时间戳。 |
| `stale` | boolean | 快照整体是否超过新鲜度期限：响应生成时 `now - generatedAt > 15 秒`。为 `true` 时客户端必须把整体状态展示为 `unknown` /「数据未更新」，不得显示 `healthy`；连接状态仍以请求成功为准。 |
| `overall` | enum | `healthy`、`warning`、`critical`、`unknown`；由后端聚合，客户端不得自行重算。顶层 `stale=true` 时不得直接展示为 `healthy`。 |
| `host` | object | GoDesk 所在 Linux 环境的信息；WSL 返回发行版内部信息。 |
| `host.hostname` | string | 主机名；无法读取时为空字符串。 |
| `host.platform` | string | 与 metrics 的 `platform` 取值一致，例如 `Linux`、`Linux (WSL2)`。 |
| `host.architecture` | string | Go 架构名，例如 `amd64`、`arm64`。 |
| `host.uptimeSeconds` | integer 或 null | 主机运行时间；无法读取时为 `null`。仅作信息展示。 |
| `summary` | object | 检查数量统计；口径见下文。 |
| `checks` | array | 稳定 ID 的逐项检查结果，按类别和 ID 稳定排序。 |

单个检查项的字段：

| 字段 | 类型 | 约定 |
| --- | --- | --- |
| `id` | string | 稳定、不透明的检查项 ID；客户端不得解析其内部结构。 |
| `category` | enum | `cpu`、`memory`、`storage`、`network`、`temperature`；`service` 为 V3 预留。 |
| `label` | string | 面向操作者的展示名称；可调整，不用于逻辑。 |
| `status` | enum | `healthy`、`warning`、`critical`、`unknown`。 |
| `applicable` | boolean | 当前平台、配置或拓扑是否适用该检查；为 `false` 时不参与整体状态聚合。 |
| `reason` | enum | 机器可读原因，取值见下表。 |
| `message` | string | 面向操作者的说明；文案可变，不用于逻辑。 |
| `observedAt` | RFC 3339 string | 该项最近一次有效观测或判定时间；采集失败时不更新。 |
| `since` | RFC 3339 string 或 null | 当前 `warning`、`critical` 或 `unknown` 状态的开始时间；`healthy` 或不适用时为 `null`。 |
| `stale` | boolean | 数据是否超过新鲜度期限；为 `true` 时 `status` 必须为 `unknown`、`reason` 为 `stale`。 |
| `value` | number 或 null | 主要读数；与 `thresholds` 同向，数值越大越差。复合数据放在 `details`。 |
| `unit` | string 或 null | `percent`、`celsius` 等机器可读单位；无单一读数时为 `null`。 |
| `thresholds` | object 或 null | `{ "warning": number 或 null, "critical": number 或 null }`，与 `value` 同单位、同向；不适用时为 `null`。 |
| `details` | object | 按 `category` 固定的只读详细字段；只增不改，新增可选字段不升级 `schemaVersion`。 |

`reason` 与状态的对应关系：

| 状态 | `reason` | 含义 |
| --- | --- | --- |
| `healthy` | `ok` | 检查正常。 |
| `warning` | `threshold_warning` | 数值达到警告阈值并满足持续条件。 |
| `warning` | `no_address` | 默认路由接口链路正常，但没有可用地址。 |
| `critical` | `threshold_critical` | 数值达到严重阈值并满足持续条件。 |
| `critical` | `link_down` | 默认路由接口明确断链。 |
| `unknown` | `collect_failed` | 适用检查本次采集失败；`value` 可为 `null` 或保留上次读数。 |
| `unknown` | `stale` | 读数超过新鲜度期限；`stale=true`。 |
| `unknown` | `initializing` | 尚未取得首份有效样本。 |
| `unknown`（`applicable=false`） | `not_supported` | 平台或文件系统不支持该能力。 |
| `unknown`（`applicable=false`） | `no_threshold` | 可读取读数，但没有可信阈值，不参与告警。 |
| `unknown`（`applicable=false`） | `no_default_route` | 未发现默认路由，不进行网络健康判定。 |

客户端必须容忍未知的枚举值：遇到无法识别的 `status` 按 `unknown` 展示，遇到无法识别的 `reason` 使用通用说明，不得崩溃或当作 `healthy`。

### 检查项类别与 ID

| `category` | 版本 | `id` | `value` / `unit` | `details` |
| --- | --- | --- | --- | --- |
| `cpu` | V1 | `cpu` | 总体使用率 / `percent` | `logicalCores`；V2 可选 `loadAverage`。 |
| `memory` | V1 | `memory` | 已用比例 `100 - available/total` / `percent` | `totalBytes`、`usedBytes`、`availableBytes`、`availablePercent`；V2 可选 `swapTotalBytes`、`swapUsedBytes`。 |
| `storage` | V1 | `disk:<mountpoint>`；磁盘枚举失败时为 `disk` | 触发维度的使用率 / `percent` | `mountpoint`、`dimension`（`capacity` 或 `inode`）、`capacityUsedPercent`、`inodeUsedPercent`、`totalBytes`、`usedBytes`、`availableBytes`。 |
| `network` | V1 | `network:<interface>`；无默认路由时为 `network:default` | `null` / `null` | `interface`、`linkUp`、`isDefaultRoute`、`ipv4`、`ipv6`、`rxBytesPerSecond`、`txBytesPerSecond`。 |
| `temperature` | V2 | `temperature:<sensor>`；无传感器时为 `temperature` | 摄氏度 / `celsius` | `sensor`、`chip`。 |
| `service` | V3 | `service:<unit>` | 在 V3 契约中定义 | 在 V3 契约中定义。 |

V1 不返回 `system` 类别。未来若增加主机级检查，应先在本文补充类别和 `details` 契约。动态 ID 必须稳定：磁盘使用 `disk:<mountpoint>`，网卡使用 `network:<interface>`，温度传感器使用驱动与传感器组成的稳定键；不得使用数组下标或采样序号作为 ID。

检查项按类别顺序 `cpu`、`memory`、`storage`、`network`、`temperature`、`service` 排列，同一类别内按 `id` 升序排列。

### 统计口径

- `total` 等于 `checks` 数组长度。
- `total = healthy + warning + critical + unknown + notApplicable`。
- `healthy`、`warning`、`critical`、`unknown` 只统计 `applicable=true` 的检查项。
- `notApplicable` 统计 `applicable=false` 的检查项；这类检查项的 `status` 固定为 `unknown`，但不参与整体状态聚合，也不计入 `issueCount`。
- `issueCount = warning + critical`，不包含 `unknown` 和 `notApplicable`。
- `overall` 按 `critical > warning > unknown > healthy` 聚合 `applicable=true` 的检查项；没有适用检查项时为 `unknown`。
- 顶层 `stale=true` 表示健康快照整体未及时更新，客户端必须按 `unknown` /「数据未更新」展示，不能显示 `healthy`；它不改变响应中的 `checks` 和 `summary`。
- 当 `warning` 与 `unknown` 同时存在时，`overall` 为 `warning`，但 `summary.unknown` 和对应检查项仍必须返回；界面不得隐藏未知项。
- 采集失败、读数过期或尚未就绪的适用检查必须返回 `unknown` 和可读 `message`，不得沿用旧读数继续标记 `healthy`。旧值可以保留在 `value` 中用于诊断：超过新鲜度期限前 `reason=collect_failed`；超过后必须设置 `stale=true`、`reason=stale`。
- `since` 与状态转换信息首版只保存在内存中，GoDesk 重启后可以重新开始计时。

### 新鲜度与持续判定

- 顶层 `stale` 与 `checks[].stale` 不同：前者表示健康快照整体未更新，后者表示单项读数超过其采集周期。两者任一为 `true` 时都不得把对应状态显示为 `healthy`。
- `observedAt` 是检查项最近一次有效样本的时间。CPU、内存、存储和网络的目标采集周期为 1 秒，温度为 5 秒。
- 当 `generatedAt - observedAt` 超过 `max(3 × 采集周期, 5 秒)` 时，检查项必须标记 `stale=true`、`status=unknown`、`reason=stale`。温度检查对应约 15 秒。
- 不适用（`applicable=false`）的检查项 `observedAt` 为判定时间（通常等于 `generatedAt`），`stale` 固定为 `false`。
- 采集缺口期间的持续判定计时暂停，缺口样本不计入持续时间；缺口超过新鲜度期限时丢弃缺口前累计的持续判定状态，数据恢复后重新累计。`since` 保持为当前 `unknown` 状态的开始时间，不因从 `collect_failed` 转为 `stale` 而重置。
- 首份有效样本到达前，适用检查返回 `status=unknown`、`reason=initializing`；健康引擎尚未生成任何快照时，整个接口返回 `503`。
- 健康引擎的运行状态不新增顶层字段。`generatedAt` 落后当前时间超过 15 秒时，前端在面板提示数据未更新，但连接状态仍以请求是否成功为准，不把旧快照解释为主机离线。

### 存储契约

- 每个真实挂载点返回一个 `disk:<mountpoint>` 检查。容量和 inode 共用同一检查项，`value` 取两者中更严重的维度，`details.dimension` 指明当前读数属于 `capacity` 还是 `inode`；两个维度严重级别相同时优先 `capacity`。
- inode 统计可用时，`details.inodeUsedPercent` 必须返回并参与状态判定；文件系统不提供 inode 统计时省略该字段，只按容量判定，不额外生成不适用检查项。
- 必须过滤伪文件系统、临时文件系统、容器叠加层和只读镜像，至少包括 `proc`、`sysfs`、`devtmpfs`、`devpts`、`tmpfs`、`ramfs`、`cgroup`、`cgroup2`、`pstore`、`bpf`、`debugfs`、`tracefs`、`securityfs`、`configfs`、`fusectl`、`mqueue`、`hugetlbfs`、`autofs`、`binfmt_misc`、`nsfs`、`efivarfs`、`rpc_pipefs`、`overlay`、`iso9660`、`squashfs`、`udf` 和 `erofs`。挂载来源为 loop 设备时按只读镜像处理。
- 同一设备存在多个挂载点时只保留一个：优先 `/`，其次挂载点路径较短者；去重必须在健康判定前完成，避免同一设备重复告警。
- 单个挂载点读取失败时返回该挂载点的 `applicable=true`、`unknown` 检查，`reason=collect_failed`；整个磁盘枚举失败且无法确定挂载点时返回 `id=disk` 的 `applicable=true`、`unknown` 检查；枚举成功但没有可检查的真实文件系统时返回 `id=disk`、`applicable=false`、`reason=not_supported`。
- 磁盘阈值与恢复规则见 Spec 第 4 节；默认严重和警告阈值均为高值方向，不按容量大小调整。

### 网络契约

- V1 只检查承载默认路由的接口。存在多个默认路由时按路由 metric 升序、IPv4 优先于 IPv6、接口名升序选择；选中的接口返回 `network:<interface>`，其余接口不进入健康摘要，详细数据仍由 metrics 提供。
- 默认路由接口由采集层保留，即使链路关闭或没有地址；否则健康层无法区分断链、无地址和接口不存在。
- 没有默认路由时返回单个 `network:default` 检查，`applicable=false`、`reason=no_default_route`，不判定为故障，也不推断主机必须连接互联网。
- `linkUp=false` 时返回 `critical`、`reason=link_down`；链路正常但没有可用 IPv4/IPv6 地址时返回 `warning`、`reason=no_address`；其余情况为 `healthy`。
- `rxBytesPerSecond`、`txBytesPerSecond` 单位为字节/秒；零流量不代表链路异常，不参与状态判定。
- 网关或外网探测必须由用户显式配置，默认关闭，并分别呈现探测目标与结果；它们不改变 V1 的默认网络状态。
- 不能将浏览器的网络状态当作 Linux 网卡状态。

### 温度契约

- 温度检查在 V2 实现。`value` 使用摄氏度；传感器存在时按传感器分别返回 `temperature:<sensor>`。
- 优先使用 `hwmon` 或 thermal 子系统暴露的传感器及其阈值。传感器提供警告阈值时作为 `thresholds.warning`，提供 critical 阈值时作为 `thresholds.critical`；缺失的阈值字段为 `null`。
- 传感器可读但没有可信阈值时，返回 `applicable=false`、`reason=no_threshold`，保留 `value` 供展示，但不生成 `warning`/`critical`，也不参与整体状态。
- 平台没有可用传感器时返回单个 `temperature` 检查，`applicable=false`、`reason=not_supported`。
- 不得伪造温度，也不得对所有芯片统一套用固定温度线。

### 错误与连接语义

- `200`：返回最新健康快照，即使其中某些或全部适用检查为 `unknown`。响应 `Content-Type` 为 `application/json`。
- `503`：健康引擎尚未产生第一份快照，错误码为 `health_unavailable`，响应体为 `{"code":"health_unavailable","message":"..."}`。
- `401`：未登录，由现有会话认证中间件返回。
- 单项采集失败不改变 HTTP 状态码，也不使其他检查项失败。
- 浏览器请求超时、网络错误或连续失败属于前端连接状态，不是该 API 的主机健康结果；前端轮询与连接状态见 Spec 第 3.4 节。
- 所有响应设置 `Cache-Control: no-store`，响应为只读，不触发服务操作、网络配置变更或其他特权动作。

## 采集与权限

- 现有 CPU、内存、磁盘和网络指标使用 `github.com/shirou/gopsutil/v4`。
- 端口使用 `gopsutil/net.Connections("all")`，过滤 `AF_INET` 与 `AF_INET6`；进程名读取 `/proc/<pid>/comm`。
- 健康检查优先复用现有采集结果；默认路由和链路状态通过 procfs、sysfs 或 netlink 只读查询获取，不调用 shell；温度等能力只读 Linux sysfs/procfs。
- 不隐式提升权限，不提供进程操作。权限不足或平台不支持时按检查项语义返回 `unknown` 或 `applicable=false`。
