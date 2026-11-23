# 服务管理

「服务管理」应用列出被管理主机上的 system 级服务，显示运行时状态、开机自启状态和描述，并支持启动、停止、重启、启用/禁用开机自启以及查看最近的 journal 日志。界面提供按名称/描述搜索、状态筛选和「异常置顶」排序，列表与详情/日志在同一窗口内分栏显示。首版只支持 systemd；OpenRC 和 BusyBox init 在后续版本接入，界面按后端上报的能力自动降级。

## 后端探测

goDesk 启动时探测一次服务后端，不在请求期间重复探测。顺序是 systemd → OpenRC（尚未实现）→ BusyBox init（尚未实现）→ none。

- systemd 的判定是 `/run/systemd/system` 存在且能找到 `systemctl`。
- `-service-backend auto`（默认）自动探测；`systemd` 强制使用 systemd；`none` 禁用服务管理。
- 探测不到后端时 goDesk 正常启动，服务管理显示空状态。探到的后端名称会写入启动日志。

## 状态与动作

运行时状态归一化为：`running`（运行中）、`completed`（已完成）、`stopped`（已停止）、`failed`（失败）、`unknown`（未知）。systemd 的 `active (exited)` 显示为已完成；`activating`、`deactivating`、`reloading` 显示为未知。详情里的原始状态保留 `active (running)` 这类后端字符串。

开机自启状态：已启用、已禁用、静态、已屏蔽、仅本次运行、不适用。静态、屏蔽和不适用单元不提供启用/禁用动作。

服务操作：

- 启动、停止、重启：同步执行，最长等待 120 秒。停止和重启需要确认。
- 启用/禁用开机自启：只改变下次开机行为，不启动或停止服务，不需要确认。
- 任何动作执行前，服务端重新确认单元存在且当前允许该动作。不允许时返回 409。
- 任意 system 单元都可以操作，没有关键服务黑名单。停止 sshd、网络或 goDesk 自身可能导致无法访问，确认框会给出通用警告。

## 详情

选中服务后，详情页展示三组字段：

- 概述：描述、规范化状态、原始状态、开机自启。
- 运行：主 PID、内存、CPU 累计时间、启动时间。
- 文件：unit 文件路径。

这些字段来自 `GET /api/v1/services/{unit}`。后端执行一次 `systemctl show`，不先枚举全部服务。未设置的数值（`[not set]`、0 PID、超出 int64 的「无限」内存值）返回 `null`，界面显示「—」；启动时间按 `systemctl` 的 `LC_ALL=C` 原始字符串展示。

## 日志

详情页的「日志」标签显示该服务最近 500 行 journal 日志。加载时机是切到日志标签、切换服务、工具栏刷新和动作完成之后；不轮询、不实时跟随，「跟随尾部」只控制加载后是否滚动到底部。日志标签内提供行内搜索、换行开关和复制。没有日志时显示空状态。日志读取权限不足时返回 403，界面显示错误而不是「暂无日志」。`journalctl` 不可用时后端上报 `logs` 能力为 false，界面不显示日志标签。

## 权限

服务管理不包含提权逻辑，所有命令以运行 goDesk 的账号执行。列表和日志在账号可读时可用；动作需要相应权限。

完整功能有两种部署方式：

1. 以 root 运行 goDesk。注意文件管理器和终端也会获得 root 权限。
2. 普通账号运行，并配置 polkit 允许 `org.freedesktop.systemd1.manage-units` 和 `org.freedesktop.systemd1.manage-unit-files`；读取日志需要加入 `systemd-journal` 组。

权限不足时动作返回 403，界面显示明确错误。goDesk 不在启动时探测写权限。

## HTTP 接口

所有接口都需要操作者登录，响应带 `Cache-Control: no-store`。

| 方法与路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `GET /api/v1/services` | | `200` 后端、能力和服务数组 |
| `GET /api/v1/services/{unit}` | | `200` 单服务详情 |
| `POST /api/v1/services/{unit}/{action}` | | `204` |
| `GET /api/v1/services/{unit}/logs?lines=200` | | `200` `{"lines":[...]}` |

`action` 只能是 `start`、`stop`、`restart`、`enable`、`disable`。`lines` 默认 200，范围 1–1000。

列表响应示例：

```json
{
  "backend": "systemd",
  "capabilities": {
    "start": true,
    "stop": true,
    "restart": true,
    "enable": true,
    "disable": true,
    "logs": true,
    "stateReliable": true
  },
  "services": [
    {
      "name": "ssh.service",
      "description": "OpenBSD Secure Shell server",
      "state": "running",
      "stateDetail": "active (running)",
      "bootState": "enabled",
      "actions": ["stop", "restart", "disable"]
    }
  ]
}
```

`backend` 为 `none` 时 `services` 为空，能力全为 false，HTTP 状态仍是 200。前端只使用 `capabilities`、`actions` 和规范化字段，不按后端名称写特殊逻辑。

详情响应示例：

```json
{
  "name": "ssh.service",
  "state": "running",
  "stateDetail": "active (running)",
  "bootState": "enabled",
  "mainPid": 1234,
  "memoryBytes": 13844480,
  "cpuUsageNs": 2391500000,
  "activeEnterTimestamp": "Fri 2026-11-21 10:00:00 CST",
  "fragmentPath": "/usr/lib/systemd/system/ssh.service"
}
```

详情端点直接调用 `systemctl show`，不先枚举全部服务；单元不存在时返回 404。`mainPid`、`memoryBytes`、`cpuUsageNs` 可为 `null`；`activeEnterTimestamp` 和 `fragmentPath` 未设置时为空字符串。

错误响应为 `{"code":"permission","message":"..."}`。状态码：400（`invalid_unit`、`invalid_action`、`invalid_lines`）、403（`permission`）、404（`not_found`）、409（`action_not_allowed`、`logs_unavailable`）、422（`operation_failed`）、504（`timeout`）。单元名会严格校验，命令不经过 shell。

## 已知限制

- 不管理 `--user` 单元。
- 不提供实时日志跟随；日志只在切标签、切服务、工具栏刷新和动作后重新加载。
- 详情端点每次请求执行一次 `systemctl show`；列表可见时每 10 秒刷新，选中服务的详情也会随刷新重新拉取。
- 不做服务依赖图；未加载单元的 Description 为空，因为 `list-unit-files` 不提供描述。
- 动作同步执行，浏览器断开不会取消 systemd job；下次刷新会显示真实状态。
- 列表每 10 秒刷新一次，只在服务窗口可见时进行；窗口重新聚焦时立即刷新。
- OpenRC 和 BusyBox init 尚未实现；接口和能力模型已经预留。
