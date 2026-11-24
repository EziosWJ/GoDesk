# GoDesk Extension Host 实施 Spec

**状态** 已定案，V1 待实现。

[首版契约](../../docs/extensions.md)定义双模式共享的插件行为、Manifest 与运行接口。[ADR 0009](../../docs/adr/0009-embed-extension-host-from-separate-module.md)记录跨仓库与进程边界。本文定义交付范围、迁移步骤和验收条件。

## 1. 交付目标

先把同一份最小 Web + Lua ZIP 跑通在 `godesk-ext` 和 GoDesk 中，证明两个仓库能够独立发布。再交付 Mihomo 插件，连接部署者已经安装和配置好的 Mihomo 实例。

Mihomo 首轮交付包括 REST 查询、实时流量、SQLite 配置保存，以及查询和按授权重启已有的 `mihomo.service`。部署者负责准备二进制、配置、systemd unit 和所需 TUN 权限。服务部署功能后移，详见第 7 节。

V1 运行部署者信任的插件，使用同源 iframe、原生 HTTP/WS 和进程内 Lua。独立模式默认本机访问，面向单操作者。Lua 可使用标准 `os` 和 `io` 发起主机命令，`os.exit()` 结束当前实例。插件升级与回滚、框架级 HMR、OpenRC、远程多操作者、插件市场、独立后端运行时与 MCP 后续按实际用例设计。

PostgreSQL 备份示例独立于 Mihomo 工单交付，用于验证 Lua 的异步进程接口和双模式兼容性。GoDesk 用于日常运行，独立宿主用于开发联调。验收条件见[扩展宿主契约](../../docs/extensions.md#postgresql-备份示例)。

## 2. 当前代码与迁移落点

| 当前能力 | 迁移落点 |
| --- | --- |
| [`cmd/godesk`](../../backend/cmd/godesk/main.go) 创建 SQLite、原生应用和 HTTP 监听器，[`httpserver`](../../backend/internal/httpserver/routes.go) 注册认证、应用与静态页面。 | GoDesk 新增一个外部库装配点和扩展路由。复用现有监听、认证和关闭流程。Host 初始化或单插件启动出错时，GoDesk 内置入口继续可用。 |
| [认证](../../backend/internal/auth/http.go) 用现有会话中间件保护原生 API，[SQLite](../../docs/adr/0005-use-sqlite-for-persistent-state.md) 保存操作者和终端设置。 | GoDesk 传入会话适配，Extension Host 初始化自身 SQLite。GoDesk 继续使用原 `godesk.db`。 |
| [应用表](../../frontend/src/apps.ts) 和[窗口管理](../../frontend/src/App.tsx) 驱动开始菜单、窗口和任务栏。现有 [Vite 代理](../../frontend/vite.config.ts) 覆盖 `/api`。 | 开始菜单新增一个「扩展」入口，列表按插件 ID 打开或聚焦既有窗口。保持内置应用表的现有入口，通过现有窗口管理显示 iframe。联调代理覆盖扩展资源、API 和 WS 路径。 |
| [服务管理](../../backend/internal/services/services.go) 已有 Go `Backend`、systemd 状态、动作模型和 `none`。动作校验部分位于 [HTTP 层](../../backend/internal/services/http.go)，提权位于 [systemd 实现](../../backend/internal/services/systemd.go)。 | 迁移系统服务模型、探测、解析与命令执行。把通用动作校验下沉到共享操作层，GoDesk HTTP 保留现有路由、响应和错误映射。GoDesk 原生调用和插件调用装配各自的执行策略。 |
| [文件管理](../../backend/internal/files/files.go) 已有复制、移动和文本操作，[管理员文件模式](../../backend/internal/files/elevated.go) 重新调用当前二进制。 | 后续根据用例提取共享文件操作。原有 HTTP、文件冲突语义和 GoDesk 管理员入口继续由 GoDesk 管理。 |
| [终端](../../backend/internal/terminal/session.go) 管理 PTY 和会话，[端口监控](../../backend/internal/monitor/ports.go) 可显示 PID，[健康引擎](../../backend/internal/health/health.go) 消费采集快照。 | PTY、健康规则和界面留在 GoDesk。按实际用例再实现非交互进程能力或提取监控采集器，嵌入模式共享一个采集器。 |

## 3. 仓库结构与装配

```text
GoDesk/
  backend/go.mod
  backend/cmd/godesk/
  backend/internal/extensions/
  frontend/src/extensions/

Extension-Host/
  go.mod
  host/
  hostsys/services/
  cmd/godesk-ext/
  internal/{manifest,bundle,lifecycle,lua,gateway,store}/
  web/
  examples/mihomo/
```

GoDesk 保留 `backend/go.mod` 及模块名。Extension 仓库根目录的 Go module 路径为 `github.com/EziosWJ/Extension-Host`。`host` 是嵌入所需的公共 Go 接口，`hostsys/services` 在抽取阶段提供原生应用和引擎共用的服务能力。其他通用主机能力有实际调用方后再提供公共接口。运行引擎和 `godesk-ext` 独立构建，依赖图中没有 GoDesk 模块。 [Extension Host 仓库](https://github.com/EziosWJ/Extension-Host)

两种入口都调用 `host.Open`、`Restore`、`Handler` 和 `Close`，共用插件管理逻辑。以下是公共 API 的签名草案，具体类型由实现提供。

```go
func Open(ctx context.Context, opts Options) (*Host, error)

func (*Host) Restore(ctx context.Context) error
func (*Host) Handler(opts HTTPOptions) http.Handler
func (*Host) List(ctx context.Context) ([]Plugin, error)
func (*Host) Install(ctx context.Context, zip io.Reader) (Plugin, error)
func (*Host) Enable(ctx context.Context, id string) error
func (*Host) Start(ctx context.Context, id string) error
func (*Host) Stop(ctx context.Context, id string) error
func (*Host) Disable(ctx context.Context, id string) error
func (*Host) Uninstall(ctx context.Context, id string, opts UninstallOptions) error
func (*Host) Close(ctx context.Context) error
```

`Options` 提供运行数据目录、日志、能力实现和部署授权配置。`HTTPOptions` 提供路由挂载与会话适配。管理页面可通过 Host handler 查询及修改插件配置。包格式、Lua、路由分发和 SQLite 表由 Host 实现。HTTP 监听、产品登录、信号处理和 UI 由入口装配。Graceful shutdown 也关闭由扩展网关接管的 WS 连接。

GoDesk 在现有 HTTP mux 中注册扩展路由，优先于桌面资源兜底。`godesk-ext` 默认只监听本机回环地址，独立管理页复用 Host 的管理路由。两种模式以相同数据格式管理各自的数据目录。GoDesk 和 Extension Host 的状态存储边界见[首版契约](../../docs/extensions.md#生命周期与存储)。

## 4. 联合开发与独立发布

在两个仓库的上级目录创建本地工作区。

```sh
go work init ./GoDesk/backend ./Extension-Host
```

工作区替换仅用于本地联调。Extension Host 源码推送到 `https://github.com/EziosWJ/Extension-Host.git`，由该仓库打独立 Go module tag 并发布 `godesk-ext`。随后 GoDesk 在 `backend/go.mod` 固定该版本并更新 `go.sum`，继续通过现有 [tag 发布工作流](../../.github/workflows/release.yml) 产出单二进制。两个仓库的发布及 CI 都设置 `GOWORK=off`，并用 `CGO_ENABLED=0` 构建。GoDesk 发布依赖只包含可解析的正式版本，构建机无需 checkout Extension 源码。

库 tag、插件版本和 Host API 兼容范围各自演进。GoDesk 升级 Go 依赖时，使用相同插件包验收 Host API 的兼容性。 [Go 工作区](https://go.dev/doc/tutorial/workspaces) · [Go Modules 参考](https://go.dev/ref/mod)

## 5. 实施阶段与验收

### A. 独立运行闭环

实现独立模块、最小管理入口及共享引擎。使用固定的 Web + Lua 示例 ZIP，覆盖 Manifest、安装、加载、读取配置、业务 HTTP、事件流和 SQLite。

- 在只有 Extension 仓库的环境用 `GOWORK=off CGO_ENABLED=0` 构建。在没有 GoDesk 程序、数据目录或登录会话的环境启动 `godesk-ext`，浏览器可以打开本机管理页并运行示例插件。
- 安装 ZIP 后显示未启用。启用后，Web 能调用 Lua、接收 WS 事件并写入业务 SQLite。验证 Web-only 和 Lua-only 两类入口各自可运行。
- 宿主重启后恢复已启用插件并读取已写入的数据。停止、禁用、卸载、保留数据和显式清除符合[生命周期契约](../../docs/extensions.md#生命周期与存储)。启动失败能显示错误并再次启动。
- 无效包路径、缺失入口、不兼容版本和未获授权的 Host 调用均返回可理解的错误。

### B. GoDesk 嵌入与拆分验收

Extension Host 发布可依赖的 tag。GoDesk 添加固定模块依赖、现有会话适配和一个「扩展」入口。

- 仅检出 GoDesk，使用 `GOWORK=off` 完成测试与单二进制发布构建。启动只打开现有 GoDesk HTTP 监听器。
- 用已有操作者会话打开**阶段 A 的同一份 ZIP**。GoDesk 可通过「扩展」入口打开窗口，HTTP 和 WS 行为与独立模式一致。关闭窗口只断开该窗口订阅，宿主仍显示已运行。关闭宿主时已有 WS 能退出。
- 内置认证、桌面静态路由、终端和服务管理回归通过。单插件启动失败或 Host 未就绪时，内置功能仍可用。
- 阶段完成后，两个仓库可以脱离本地 `go.work` 各自构建，并运行同一包。此处完成拆分验收。

### C. 共享 systemd 与 Mihomo 插件

先迁移共享服务能力，再让 GoDesk 原生服务管理 API 和插件 Host API 调用该实现。复用现有服务接口测试、解析测试和错误映射测试。继续使用现有 systemd 探测与 `none` 行为。插件端的显式 sudo 动作直接执行授权命令，避免用 `/usr/bin/true` 探测挡住只获准重启指定 unit 的运行账号。GoDesk 原生执行策略及已有 HTTP 接口继续兼容。 [现有 sudo 探测](../../backend/internal/privileges/sudo.go#L22) · [服务契约](../../docs/services.md)

- 使用部署者已经准备好的 Mihomo 控制接口和 `mihomo.service`。两种模式安装同一 Mihomo ZIP，能查询 REST 数据、展示实时流量、保存配置并在重启后读取。
- 有授权时查询并重启已有 `mihomo.service`。无授权、服务缺失或 systemd 不可用时，插件显示对应失败原因，宿主及其他插件继续运行。
- GoDesk 的原生服务管理继续保持既有响应及写操作语义。两种调用方都使用 Extension Host 的 systemd 实现。

### D. 开发命令与首轮交付

- `dev`、`run`、`test`、`validate`、`pack`、`logs` 在没有 GoDesk 的环境完成[命令契约](../../docs/extensions.md#独立开发命令)。同一目录构建出的 ZIP 无需重打包即可进入嵌入模式。
- Web 构建产物变化后刷新页面。Lua 修改后重建实例并保留开发 SQLite。错误脚本有可定位的日志，修正后可以再次重载。
- Mock 测试覆盖 Mihomo REST 响应、实时 WS 事件，以及已授权和未授权的服务调用。Local 测试使用明确配置的真实服务和独立测试 SQLite。
- A、B 证明分离成立，C、D 完成首轮交付。验收使用部署者已有 Mihomo，服务部署功能没有首轮交付依赖。

## 6. GoDesk 兼容要求

- 保留现有 `backend/go.mod`、`godesk.db` 及原生 HTTP API。
- 原生内置应用可以调用共享 Go 能力，不依赖插件已安装或启动。
- 通用主机能力从有两个实际调用方的 systemd 开始。后续按需求提取文件、非交互进程及监控，Shell/PTY、管理员文件界面和健康判定继续由 GoDesk 管理。
- 两个仓库共用插件契约。只有 Extension Host 仓库拥有 Manifest、Lua、网关、插件生命周期及业务库实现。

## 7. 后续设计记录 · 服务部署

服务部署安排在首轮之后。保留已讨论的边界，后续立项时单独验收。

- 面向主机已有二进制和配置。GoDesk 服务管理界面与 `godesk-ext` CLI 共用 systemd unit 安装能力。输入是 `.service` 文件，Mihomo 内置模板可作为后续交互简化。
- 主机管理员显式执行。GoDesk 可沿用同一二进制的短时 sudo 子进程模式，独立 CLI 由管理员运行。Lua 首轮只查询和重启已有服务。
- 校验并安装新的 unit，随后执行 `daemon-reload`。同名返回冲突。立即启动和开机自启分别可选，启动失败保留 unit 供排查。插件卸载与服务部署是独立生命周期。
- Mihomo TUN 相关权限由其 systemd unit 提供。首轮用例仅调用现有服务，Mihomo 安装、unit 上传、模板和部署命令均后移。 [systemctl](https://www.freedesktop.org/software/systemd/man/latest/systemctl) · [Linux TUN/TAP](https://docs.kernel.org/networking/tuntap.html)
