# goDesk 服务管理 Spec

## 目标

把「服务管理」应用从模拟数据改为真实管理被管理主机上的 system 级服务。首版只实现 systemd，通过启动时探测的后端抽象为 OpenRC 和 BusyBox init 预留扩展点。前端只依赖后端上报的全局能力和每个服务的可用动作，不按具体后端写分支。

单机、单操作者、运行账号权限模型保持不变。

## 范围

首版包含：

- 已安装 service 单元的列表，合并运行时状态、描述和开机自启状态
- 详情：规范化状态、原始状态、开机自启状态、Description
- 生命周期动作：start / stop / restart
- 开机动作：enable / disable
- 日志：一次性读取最近 N 行
- 前端的搜索、状态筛选、轮询、动作确认和错误反馈

首版不包含：

- `--user` 单元
- 实时日志跟随
- 服务依赖图或 impact 文案
- 关键单元黑名单
- unit 文件编辑、mask/unmask、reset-failed
- goDesk 自身安装为系统服务
- 操作审计日志
- OpenRC / BusyBox 的实际实现（只保留接口和探测顺序）

## 术语

- **服务后端**：实现服务列表和操作的运行时实现。首版是 systemd，未来是 OpenRC、BusyBox init。
- **能力声明**：后端整体支持哪些动作，以及状态是否可靠。
- **可用动作**：某个具体服务在当前状态下允许执行的动作，由后端计算。

## 设计

### 后端接口

`backend/internal/services` 暴露最小接口：

```go
type Backend interface {
    Name() string
    Capabilities() Capabilities
    List(ctx context.Context) ([]Service, error)
    Start(ctx context.Context, unit string) error
    Stop(ctx context.Context, unit string) error
    Restart(ctx context.Context, unit string) error
    Enable(ctx context.Context, unit string) error
    Disable(ctx context.Context, unit string) error
    Logs(ctx context.Context, unit string, lines int) ([]string, error)
}

type Capabilities struct {
    Start, Stop, Restart, Enable, Disable, Logs bool
    StateReliable                               bool
}

type Service struct {
    Name        string
    Description string
    State       State
    StateDetail string
    BootState   BootState
    Actions     []Action
}
```

枚举（JSON 字符串）：

- `State`：`running`、`completed`、`stopped`、`failed`、`unknown`
- `BootState`：`enabled`、`disabled`、`static`、`masked`、`runtime`、`not_applicable`
- `Action`：`start`、`stop`、`restart`、`enable`、`disable`

约束：

- `Capabilities` 是后端级；`Actions` 是单元级，后端根据当前状态计算。
- 前端只渲染 `Actions` 里的动作，不自行推断。
- `none` 后端返回空列表和全 false 的能力。
- 后端在动作执行前重新校验单元和动作，不能只信前端传来的状态。

### 探测与选择

- 在 `cmd/godesk/main.go` 启动时探测一次并构造后端，传入 `httpserver.New`。
- 探测顺序：systemd → OpenRC（预留）→ BusyBox（预留）→ none。
- systemd 判定：`/run/systemd/system` 是目录，并且 `exec.LookPath("systemctl")` 成功；任一不满足则跳过。
- 参数 `-service-backend auto|systemd|none`，默认 `auto`。非法值启动报错。`systemd` 跳过探测强制使用（测试/离线场景），`none` 禁用。
- 探测成功后 `slog.Info("service backend", "backend", name)`。
- 探测不到不阻止启动；API 返回 `none`，前端显示空状态。
- systemd 后端构造时解析 `journalctl` 路径；找不到则 `Capabilities.Logs=false`，其余动作不受影响。

### 权限

- 不做代码级提权：不调用 sudo、不安装 setuid、不在应用内接 polkit。
- 命令始终以 goDesk 进程账号执行。
- `docs/services.md` 记录两种部署路径：
  1. 以 root 运行 goDesk（文件管理器、终端也会是 root 权限）。
  2. 普通账号 + polkit 规则允许 `org.freedesktop.systemd1.manage-units` 和 `org.freedesktop.systemd1.manage-unit-files`，并加入 `systemd-journal` 组以读取日志。
- 权限不足映射为 403；列表和日志在可读时保持可用。
- 启动时不做写权限探测，动作失败时反馈。

### systemd 实现

命令（启动时用 `exec.LookPath` 固定绝对路径，`LC_ALL=C`，不经过 shell）：

| 用途 | 命令 |
| --- | --- |
| 清单 | `systemctl list-unit-files --type=service --no-legend --plain --no-pager` |
| 运行时 | `systemctl list-units --type=service --all --full --no-legend --plain --no-pager` |
| 动作 | `systemctl <start\|stop\|restart\|enable\|disable> -- <unit>` |
| 日志 | `journalctl -u <unit> -n <N> --no-pager --quiet -o short-iso` |

补充：

- 单单元属性查询用 `systemctl show -p ... -- <unit>`；首版列表不逐单元调用，避免额外开销和把未加载单元载入内存。
- 不解析 `systemctl status` 的人类可读文本，不使用 `--output=json`（旧 systemd 没有）。
- 清单解析取每行前两个字段（新版 systemd 可能带第三列 vendor preset）；运行时解析 5 列，Description 允许空格。
- 超时：列表约 5s，动作 120s，日志约 10s。
- 动作同步执行，返回后前端刷新；客户端断开时 systemctl 进程被杀，但 systemd job 继续，下一次刷新会纠正状态。

清单合并：

- `list-unit-files` 提供已安装清单和 `UnitFileState`。
- `list-units --all` 提供已加载单元的运行时状态和 Description。
- 按单元名 join；只在运行时出现（generated/transient）的单元也列出，`BootState=not_applicable`。
- 隐藏模板文件 `foo@.service`，保留实例 `foo@bar.service`。
- 未出现在运行时清单的单元视为 `stopped`，Description 为空（已知取舍，见下）。

状态映射：

| systemd | 规范化 |
| --- | --- |
| `active` + `running` | `running` |
| `active` + `exited` | `completed` |
| `active` + 其他 SubState | `running` |
| `inactive` | `stopped` |
| `failed` | `failed` |
| `activating` / `deactivating` / `reloading` / 其他 | `unknown` |

`StateDetail` 保留 `ActiveState (SubState)`，例如 `active (exited)`。

开机状态映射：

| UnitFileState | BootState |
| --- | --- |
| `enabled` | `enabled` |
| `disabled` | `disabled` |
| `static` / `indirect` / `alias` | `static` |
| `masked` / `masked-runtime` | `masked` |
| `enabled-runtime` / `linked-runtime` | `runtime` |
| `linked` | `enabled` |
| `generated` / `transient` / `bad` / 空 | `not_applicable` |

可用动作：

- 生命周期：
  - `running` / `completed`：`stop`、`restart`
  - `stopped`：`start`
  - `failed`：`start`、`restart`
  - `unknown`：`start`、`stop`、`restart`
  - `masked` 且未运行：无生命周期动作；运行中的 masked 单元只给 `stop`
- 开机：
  - `enabled`：`disable`
  - `disabled`：`enable`
  - 其他：无
- 与 `Capabilities` 求交集；顺序固定为 start、stop、restart、enable、disable。
- 动作是建议值；handler 执行前重新校验，不允许时返回 409。

日志：

- 默认 200 行，`lines` 允许 1–1000。
- 输出按行拆分，去掉末尾空行。
- `journalctl` 不存在 → `Logs=false`；直接请求日志返回 409 `logs_unavailable`。
- “No journal files were found” → 200 空数组；权限错误 → 403；其他失败 → 422。
- 不做 follow。

命令错误映射：

| 情况 | HTTP |
| --- | --- |
| stderr 含 `Access denied` / `Interactive authentication required` / `Authentication is required` / `Permission denied` / polkit 相关 | 403 `permission` |
| stderr 含 `Unit ... not found` / `not loaded` | 404 `not_found` |
| context deadline | 504 `timeout` |
| 其他非零退出 | 422 `operation_failed`，message 带裁剪后的 stderr |

## API

所有路由挂在 `RequireSession` 后，响应 `Cache-Control: no-store`。

### GET /api/v1/services

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

- `backend:"none"` 时 `services` 为空数组，能力全 false，HTTP 200。
- 不提供单独的 info 或 detail 接口；列表即当前数据。

### POST /api/v1/services/{unit}/{action}

- `action` 仅允许 `start`、`stop`、`restart`、`enable`、`disable`，不读 body。
- 成功返回 204。
- 单元名在 handler 中严格校验：只允许字母、数字、`:_.@-` 和 `\xNN` 转义形式，拒绝 `-` 开头；参数前加 `--`；绝不经过 shell。
- 执行前重新确认单元存在且动作可用；否则 409 `action_not_allowed` 或 404 `not_found`。

### GET /api/v1/services/{unit}/logs?lines=200

```json
{ "lines": ["2026-11-19T19:12:29+08:00 host sshd[199]: Server listening on :: port 2222."] }
```

- `lines` 缺省 200；非整数、0 或超过 1000 → 400 `invalid_lines`。
- 无日志 → 200 `{"lines":[]}`。
- 权限不足 → 403 `permission`。

### 错误响应

```json
{ "code": "permission", "message": "Access denied" }
```

| 状态 | code |
| --- | --- |
| 400 | `invalid_unit`、`invalid_action`、`invalid_lines` |
| 403 | `permission` |
| 404 | `not_found` |
| 409 | `action_not_allowed`、`logs_unavailable` |
| 422 | `operation_failed` |
| 504 | `timeout` |

## 前端

新增 `frontend/src/services.ts`，沿用 `hostFiles.ts` 的请求/错误封装；`Services.tsx` 移除 mock。

- 加载：窗口打开时请求 `GET /api/v1/services`；每 10s 轮询，但只在服务窗口未最小化且浏览器页面可见时进行（参照 `TerminalPage` 的 `active` 传参方式，必要时给 `apps.services.Content` 增加 `active` 属性）；窗口关闭或不可见时停止；提供手动刷新。
- 列表：服务名 + 状态列；工具栏提供状态筛选（全部/运行中/已完成/已停止/失败/未知）和客户端搜索（名称 + 描述，大小写不敏感）；默认按名称升序。
- 详情：名字、状态、`stateDetail`、开机自启、Description。
- 详情/日志两个标签页，`role="tablist"`；`capabilities.logs=false` 时不显示日志页。日志在首次切到该页时加载，之后手动刷新；当前服务切换时重新加载。空日志显示「暂无日志」，错误用 `role="alert"` 内联显示。
- 动作：只渲染 `service.actions`；生命周期和开机动作分组；`stop`/`restart` 弹确认框（服务名、Description、通用中断警告），`start`/`enable`/`disable` 直接执行。
- 动作进行中禁用该服务的全部动作按钮并显示「正在启动/停止/重启…」；成功刷新列表和当前日志；失败内联显示。
- `backend` 驱动副标题：`systemd 服务` / `OpenRC 服务` / `BusyBox 服务`；`none` 显示「未检测到受支持的初始化系统（systemd / OpenRC / BusyBox）」。
- `stateReliable=false` 时在列表上方提示「该后端无法可靠判断服务状态」。
- 前端不按 backend 名称写特殊逻辑，只读 `capabilities`、`actions` 和规范化字段。
- 401 沿用现有登录过期处理。

## 实现拆分

1. **后端骨架**：`internal/services` 的接口、枚举、`none` 后端、`Detect`、`-service-backend` 参数、`main.go` 和 `httpserver` 接线；空列表 API + 基础测试。
2. **systemd 清单**：命令解析、清单合并、状态/开机状态映射、可用动作计算、模板隐藏；fixture 单元测试。
3. **systemd 动作与日志**：动作执行、超时、stderr 映射、日志读取与边界；`http.go` 路由；fake backend 的 handler 测试。
4. **前端数据层**：`services.ts` 客户端、替换 mock、列表/搜索/筛选/轮询、backend 和空状态。
5. **前端详情与动作**：详情/日志标签页、动作按钮与确认、pending/错误、开机状态、能力降级。
6. **文档与验证**：ADR-0007、`docs/services.md`、README/GLOSSARY 更新；手工集成验证。

spec 确认后，按上述拆分在 `.scratch/services/issues/` 建对应 ticket。

## 测试

- 单元测试：`list-unit-files`（含 3 列）、`list-units`（Description 含空格）、`show -p`、journal 行解析；清单 join；状态、开机状态、动作映射；探测函数可注入 stat/LookPath。
- Handler 测试：fake backend 覆盖成功、400/403/404/409/422/504、`none` 后端、日志行数边界、单元名校验。
- 手工验证（本机是 systemd 259）：
  - 普通账号运行：列表和日志可用；动作返回 403。
  - root 运行：用一次性测试单元验证 start/stop/restart/enable/disable、failed/oneshot 状态、日志。
  - `-service-backend none`：空状态，goDesk 正常启动。
  - 搜索、筛选、10s 轮询、确认框、pending、错误提示、日志刷新。
- 提交前：`go -C backend test ./...`、`pnpm --dir frontend lint`、`make build`。

## 验收条件

- systemd 主机上列表数量与 `systemctl list-unit-files --type=service` 一致（隐藏模板后），状态与 `systemctl` 一致。
- 启停重启、enable/disable 生效，UI 的开机状态和可用动作随状态变化。
- 日志显示最近 N 行，空日志和权限错误区分正确。
- `none` 后端、非 root 账号、缺少 journalctl 三种降级场景都有明确 UI，不影响 goDesk 启动。
- 单元名不能造成命令注入；所有命令不经过 shell。
- 现有认证、文件、终端、监控功能不受影响。

## 已知取舍

- 未加载单元的 Description 为空（`list-unit-files` 不提供描述）；搜索仍可按名称命中。若以后需要完整描述，再增加按需详情接口。
- 完整功能需要 root 或 polkit 授权；这是运行账号权限模型的直接结果，文档必须写明。
- 列表轮询每 10s 启动两个 systemctl 进程；只在服务窗口可见时发生。
- 同步动作最长 120s；浏览器断开不会取消 systemd job，下次刷新会显示真实状态。
- 列表解析依赖 systemctl 的稳定列格式，通过 `LC_ALL=C` 和固定参数降低风险；不做 JSON 解析以兼容旧版本。
- OpenRC/BusyBox 首版不实现；探测顺序和能力模型已预留。

## 未来后端

- **OpenRC**：`rc-status --all` 取状态，`rc-service <name> <action>` 操作，`rc-update show` / `add` / `del` 管开机；`Logs` 先为 false（需要另行决定 syslog 来源），`StateReliable` 为 true。
- **BusyBox init**：从 `/etc/inittab` 和 `/etc/init.d` 枚举；`init.d/<name> status` 退出码判断状态，可能不可靠；启停调脚本；没有统一的 enable/disable 概念，`Enable/Disable/Logs` 为 false，`StateReliable` 为 false。
- 探测顺序在 systemd 之后加入两者；UI 依赖能力声明，不需要改动。

## 文档

- `docs/adr/0007-detect-service-backend-at-startup.md`：记录启动探测、最小接口 + 能力声明、运行账号权限、CLI 而非 D-Bus 的决策及替代方案。
- `docs/services.md`：功能行为、HTTP 契约、部署权限、支持的后端和限制。
- README 功能列表增加服务管理；参数表增加 `-service-backend`。
- GLOSSARY 增加“服务后端”“能力声明”“可用动作”。
