# GoDesk Extension Host 首版契约

本文定义两种宿主模式共用的插件契约。PostgreSQL 备份是检验 Lua 命令执行和双模式兼容性的应用示例。Mihomo 示例插件和独立开发命令由各自的工单跟踪。实施顺序、迁移边界和通过条件见[实施 Spec](../.scratch/extension-host/spec.md)。

## 运行模式与信任

Extension Host 由独立仓库 [EziosWJ/Extension-Host](https://github.com/EziosWJ/Extension-Host) 交付。该仓库拥有插件运行引擎、独立命令 `godesk-ext` 和按需从 GoDesk 抽取的通用主机能力。首版优先共享 systemd 实现。

| 模式 | 入口与运行环境 |
| --- | --- |
| 嵌入 | GoDesk 导入 Extension Host，在现有 Go 进程和 HTTP 监听器内挂载其 handler，使用当前操作者会话。开始菜单的「扩展」入口提供插件列表和窗口。 |
| 独立 | `godesk-ext` 装配同一引擎并提供最小管理界面，默认监听本机回环地址，面向单操作者。运行通用插件时无需 GoDesk 源码、程序、登录或数据库。Mihomo 等外部服务按插件自身的部署要求准备。 |

两个入口使用相同的 Manifest、插件生命周期、数据格式和 HTTP/WS 契约。GoDesk 与 `godesk-ext` 可分别指定数据目录。同一插件包可以在两个入口运行，各进程管理自己的运行状态。

首版面向部署者主动信任并安装的第三方插件。Web 插件与宿主同源，其脚本可以访问父页面并使用当前浏览器会话调用宿主 API。Lua 与宿主共用进程，文件 I/O 和子进程使用宿主 Linux 运行账号权限。能力授权约束通过 Host API 发起的操作。 [GoDesk 会话契约](authentication.md) · [主机权限契约](privileges.md)

## 插件包与 Manifest

插件以 ZIP 发行。`manifest.json` 位于 ZIP 根目录，入口路径相对于包根目录。Web 入口指向构建好的 HTML，Lua 入口指向启动脚本。至少声明一个入口。宿主负责校验包路径、入口及兼容范围；包内路径必须留在包根目录内。

```text
manifest.json
web/index.html
web/assets/...
lua/init.lua
lua/proxies.lua
```

首版 Manifest 的最小示例。

```json
{
  "schemaVersion": 1,
  "id": "com.godesk.mihomo",
  "name": "Mihomo",
  "version": "0.1.0",
  "hostApi": { "min": 1, "max": 1 },
  "entry": { "web": "web/index.html", "lua": "lua/init.lua" },
  "config": {
    "controller": { "type": "string", "required": true },
    "secret": { "type": "string", "secret": true }
  },
  "capabilities": ["http", "websocket", "storage", "services"]
}
```

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | Manifest 格式版本。首版为 `1`。 |
| `id` | 稳定的插件标识，同时用于 API 路径和数据归属。发布后沿用。 |
| `name`、`version` | 操作者看到的名称与插件自身的语义化版本。 |
| `hostApi` | 插件兼容的 Host API 版本闭区间，首版 Host API 为 `1`。 |
| `entry.web`、`entry.lua` | 可选入口，分别对应 Web-only、Lua-only 或组合插件。 |
| `config` | 可选配置字段描述。`secret` 标记的值可供插件后端使用，宿主的管理响应和日志省略该值。 |
| `capabilities` | 可选的能力需求列表。部署者通过宿主配置授予实际目标和动作。 |

## 生命周期与存储

| 操作 | 契约 |
| --- | --- |
| 安装 | 校验并发布插件包，持久化安装记录。新安装处于未启用状态。已有同 ID 插件时报告冲突。 |
| 启用 | 持久化启用意图并启动。启动失败显示错误及重试入口，启用意图仍有效。 |
| 启动 | 为已启用插件创建当前进程的插件实例。重复启动收敛到同一个实例。 |
| 停止 | 停止当前实例并关闭其连接、订阅和任务，保留启用意图。可手动再启动，宿主下次启动也会恢复。 |
| 禁用 | 清除启用意图并停止实例。宿主重启后继续处于禁用状态。 |
| 卸载 | 先禁用并释放资源，再移除包、配置和授权。默认保留业务数据，显式选择清除时再删除业务库。 |
| 关闭窗口 | 释放该窗口的连接和订阅，插件实例继续随宿主运行。 |

管理界面分别显示持久化的启用意图与当前实例状态，例如「已启用，启动失败」。同一个插件的生命周期操作依序处理。首版记录版本，插件升级、备份与回滚留到后续版本。

Extension Host 在独立数据目录里管理 `host.db` 和每个插件的业务 SQLite。`host.db` 存储安装元数据、启用意图、授权和配置，业务库供所属插件使用。GoDesk 的 `godesk.db` 继续保存操作者和内置应用设置。日志按插件 ID 和版本记录。 [SQLite 架构决策](adr/0005-use-sqlite-for-persistent-state.md)

## Lua 与主机能力

每个运行中的 Lua 插件有自己的 GopherLua `LState`。一个 goroutine 管理该状态。入口装载后注册请求处理器和所需的生命周期钩子。Host 调用通过上下文传递取消，停止或重载时关闭该实例拥有的连接和任务。 [GopherLua](https://github.com/yuin/gopher-lua)

两种模式默认提供 GopherLua 的 `os` 和 `io` 标准库，包括 `os.execute`、`io.popen` 和 `os.setenv`。`os.setenv` 修改当前宿主进程的环境。`os.execute` 同步等待命令结束，同一实例的 Lua 请求串行处理。需要在任务运行期间继续响应状态查询时，插件可以通过短时命令提交后台任务。宿主提供插件数据目录，插件自行组织文件路径。`require` 从包内或 Host 预装模块加载。`print` 进入插件日志。 [GopherLua](https://github.com/yuin/gopher-lua)

`os.exit([code])` 结束当前插件实例，关闭该实例的订阅并释放 Lua 和插件 SQLite。调用会中断当前 Lua 执行，宿主随后运行已注册的停止钩子。退出后状态为「已启用、已停止」。可手动启动，宿主重启时按启用设置恢复。退出码记录在插件日志中。

| Host API 模块 | 首版职责 |
| --- | --- |
| `host.app` | 注册当前插件的 HTTP 处理器和生命周期钩子，向当前插件的浏览器订阅发布事件。 |
| `host.http` | 向已授予的目标发起 HTTP 请求。 |
| `host.ws` | 订阅已授予的目标 WebSocket，将事件交给当前插件实例。 |
| `host.storage` | 访问当前插件业务 SQLite。 |
| `host.process` | 异步启动子进程，并把退出结果交回当前 Lua 实例。 |
| `host.schedule` | 注册当前插件实例的定时任务，回调在实例的 Lua 执行队列中运行。 |
| `host.services` | 查询和重启部署者授权的已有 systemd 服务。 |

插件身份由 Host 从运行实例取得。部署配置可把 Mihomo 的网络请求限定为指定控制地址，将服务操作限定为 `mihomo.service` 的查询与重启。服务调用默认使用运行账号，部署者可为指定动作显式选择非交互 sudo。GoDesk 原生服务管理继续遵守自身权限契约。 [GoDesk 服务契约](services.md#权限)

### 异步进程

`host.process.start(program, args, onExit[, env])` 使用独立的参数数组启动命令并立即返回子进程 PID。命令继承宿主运行账号和环境。可选的 `env` 表仅修改子进程环境，用字符串设置变量，用 `false` 移除继承的变量。启动失败时返回 `nil, error`。`onExit(result)` 在实例的 Lua 执行队列中运行，和 HTTP 处理器串行执行。即使浏览器页面已关闭，回调仍会在运行中的插件内执行。

结果包含 `pid`、`exitCode` 和 `stderr`。标准输出默认丢弃，命令可自行把产物写到文件。`stderr` 保留开头 64 KiB，截断时设置 `stderrTruncated`。调用方可以使用 `error` 查看等待进程时的错误。停止实例会终止其子进程，完成回调随实例结束。插件负责在重新启动时处理上次中断的业务任务。

### 定时任务

`host.schedule.register(name, expression, fn)` 注册或替换当前插件实例的定时任务，`host.schedule.unregister(name)` 移除任务。`expression` 支持标准 5 段 cron（分 时 日 月 周）或 `@every <duration>`（例如 `@every 30m`），按宿主进程的本地时区解释。回调在该实例的 Lua 执行队列中运行，与 HTTP 处理器和进程回调串行，必须尽快返回；耗时工作应交给 `host.process`。同一任务上一次回调未返回时跳过本次触发并记录警告。回调错误写入插件日志，不自动重试。

注册只在实例运行期间有效。停止、禁用或卸载实例会清除注册；宿主重启后按启用设置恢复实例，插件需要在启动钩子中按自己持久化的设置重新注册。宿主停止期间错过的执行不补跑。名称或表达式无效时返回 `nil, error`；重复注册同名任务会替换旧任务。

## Web、HTTP 与 WebSocket

GoDesk 和独立管理界面以同源 iframe 装载插件 Web 入口。业务前端直接使用原生 `fetch` 和 `WebSocket`。可复用现有前端框架，构建产物使用相对资源路径。框架需要前端路由时，首版可使用 hash 路由。

| 路径 | 用途 |
| --- | --- |
| `/api/v1/extensions` | 管理入口。列表和安装操作位于集合路径，启用、启动、停止、禁用、卸载和配置操作按插件 ID 路由。 |
| `/extensions/{id}/web/` | 插件 Web 入口和资源。 |
| `/extensions/{id}/api/` | 当前插件注册的 HTTP 业务路由。 |
| `/extensions/{id}/events` | 当前插件到浏览器的 WebSocket 事件流。 |

双模式路径一致。嵌入模式将这些入口接入 GoDesk 会话验证。插件启用和启动后可以访问其运行入口，停止或禁用后宿主关闭该实例的现有事件订阅。窗口关闭只结束该窗口的订阅。Mihomo 实时流量经过 **Mihomo WS → Lua → Host 事件流 → 浏览器**。插件在自己的命名空间下定义业务请求、响应和事件内容。Host 根据当前路由选择插件实例，并处理包不存在、实例未运行、能力未授权和实例执行失败等宿主级错误。

## 独立开发命令

| 命令 | 行为 |
| --- | --- |
| `godesk-ext dev ./mihomo` | 从源码目录启动。前端构建产物变化时刷新 iframe，Lua 检查通过后重建实例，保留开发数据。 |
| `godesk-ext run ./mihomo` | 用指定数据目录运行插件。输入可以是目录或 ZIP。 |
| `godesk-ext test ./mihomo` | 使用临时 SQLite 和 Mock 能力运行插件测试。使用 `--local` 时接入显式配置的真实能力，测试数据仍独立。 |
| `godesk-ext validate ./mihomo` | 校验 Manifest、入口、兼容性和包结构。 |
| `godesk-ext pack ./mihomo` | 将 Web 构建产物和 Lua 文件打包，复用同一校验。 |
| `godesk-ext logs com.godesk.mihomo` | 从指定运行数据目录读取该插件的日志。 |

Mock 替换 HTTP、WS 和服务等能力实现。包加载、权限检查、Lua、网关及 SQLite 继续使用真实引擎。Local 测试针对部署者已准备好的服务。框架级 HMR 留到后续版本。

## PostgreSQL 备份示例

首版面向部署者配置的一个数据库，提供「立即备份」、定时「备份计划」和「备份历史」。Lua 使用 `host.process.start` 直接启动 PostgreSQL 的 `pg_dump`，提交后立即返回任务状态，完成回调写入插件自己的 SQLite。同一插件实例同时运行一条备份任务。GoDesk 用于正常运行，独立 `godesk-ext` 用于开发联调，两者各自保存任务历史和备份产物。

数据库地址、端口、数据库名、用户和可选密码可从插件页面保存到本地 SQLite。保存后新任务使用页面配置，已有任务继续使用启动时的参数。保存的密码不会通过页面接口读回。已有的 `PGSERVICE` 配置在首次保存前继续生效。备份计划以 cron 或 `@every` 表达式保存在同一个业务库，实例启动时重新注册；只在实例运行期间触发，宿主停止期间错过的执行不补跑。定时备份与手动备份共用同一条「运行中」保护。

同一份 ZIP 可分别在两个入口验收。验收覆盖连接配置持久化、成功、失败、刷新后继续查看、保存或清空备份计划后按计划触发或停止触发，以及用备份恢复到空测试库。运行和恢复步骤见 Extension Host 仓库的 `examples/postgres-backup/README.md`。

### 从源码联调 GoDesk

常规开发只需克隆 GoDesk。直接运行 `make dev`，Go 会使用 `backend/go.mod` 中固定的 Extension Host 版本。

要用本机的 Extension Host 源码联调，将两个仓库放在同一父目录。如果 GoDesk 根目录还没有 `go.work`，从该目录执行一次：

```sh
GOWORK=off go work init ./backend ../Extension-Host
make dev
```

之后运行 `make dev` 或 `make build` 都会使用同级的 Extension Host 源码，包括未提交的改动。修改 Host 的 Go 代码后，重启开发进程即可生效。`go.work` 和 `go.work.sum` 由 Git 忽略。

已有工作区时，可以用 `GOWORK=off make dev` 临时切回固定版本。要在本地按固定版本生成发布二进制，运行 `GOWORK=off make build`。
