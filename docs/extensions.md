# GoDesk Extension Host 契约

本文定义嵌入 GoDesk 与独立 `ext` 两种宿主模式共用的插件契约，对应当前 GoDesk v0.1.0。插件包、生命周期、数据格式和 HTTP/WS 行为由两个入口共同实现。实现细节与更多示例见 Extension Host 仓库的 [README](https://github.com/EziosWJ/Extension-Host/blob/main/README.md)、[原生插件契约](https://github.com/EziosWJ/Extension-Host/blob/main/docs/native-plugins.md) 和 [插件命名与市场规范](https://github.com/EziosWJ/Extension-Host/blob/main/docs/plugin-naming-and-marketplace-spec.md)。

## 运行模式与信任

Extension Host 由独立仓库 [EziosWJ/Extension-Host](https://github.com/EziosWJ/Extension-Host) 交付。该仓库拥有插件运行引擎、独立命令 `ext` 和按需从 GoDesk 抽取的通用主机能力。首版优先共享 systemd 实现。

| 模式 | 入口与运行环境 |
| --- | --- |
| 嵌入 | GoDesk 导入 Extension Host，在现有 Go 进程和 HTTP 监听器内挂载其 handler，使用当前操作者会话。开始菜单的「扩展」入口提供插件列表和窗口。 |
| 独立 | `ext` 装配同一引擎并提供最小管理界面，默认监听 `127.0.0.1:5001`，面向单操作者。运行通用插件时无需 GoDesk 源码、程序、登录或数据库。数据目录通过 `--data-dir` 指定，默认 `./ext-data`。 |

两个入口使用相同的 Manifest、插件生命周期、数据格式和 HTTP/WS 契约。GoDesk 与 `ext` 可分别指定数据目录。同一插件包可以在两个入口运行，各进程管理自己的运行状态。依赖外部服务的插件按自身部署要求准备。

部署者主动启用自己信任的插件。Web 插件与宿主同源，其脚本可以访问父页面并使用当前浏览器会话调用宿主 API。Lua 与宿主共用进程，文件 I/O 和子进程使用宿主 Linux 运行账号权限，原生插件以同一宿主账号作为子进程运行。[GoDesk 会话契约](authentication.md) · [主机权限契约](privileges.md)

## 插件包与 Manifest

插件以 ZIP 发行。`manifest.json` 位于 ZIP 根目录，入口路径相对于包根目录。Web 入口指向构建好的 HTML，Lua 入口指向启动脚本，原生入口指向 Linux ELF。至少声明一个入口。宿主负责校验包路径、入口及兼容范围；包内路径必须留在包根目录内。

```text
manifest.json
web/index.html
web/assets/...
lua/init.lua
native/worker
```

面向 Web 与 Lua 的完整 Manifest 示例：

```json
{
  "schemaVersion": 1,
  "id": "com.example.hello",
  "name": "Hello Extension",
  "version": "0.1.0",
  "minHostVersion": "0.1.0",
  "hostApi": { "min": 1, "max": 1 },
  "description": "Demonstrates a web interface backed by Lua APIs and live events.",
  "author": { "name": "Jian Wang", "url": "https://jianwang.de" },
  "license": "MIT",
  "homepage": "https://github.com/EziosWJ/Extension-Host",
  "repository": "https://github.com/EziosWJ/Extension-Host",
  "icon": "web/icon.svg",
  "categories": ["utility"],
  "keywords": ["hello", "example"],
  "requirements": { "os": ["linux"] },
  "entry": { "web": "web/index.html", "lua": "lua/init.lua" },
  "config": {
    "greeting": {
      "type": "string",
      "default": "你好",
      "label": "Greeting",
      "description": "Text returned by the greeting endpoint."
    },
    "token": {
      "type": "string",
      "secret": true,
      "label": "Token",
      "description": "Optional secret value used to demonstrate redaction."
    }
  },
  "locales": {
    "zh-CN": {
      "name": "Hello 示例",
      "description": "演示通过 Lua API 和实时事件驱动的网页界面。",
      "config": {
        "greeting": { "label": "问候语", "description": "问候接口返回的文字。" },
        "token": { "label": "令牌", "description": "用于演示密钥隐藏的可选值。" }
      }
    }
  }
}
```

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | Manifest 格式版本。首版为 `1`。 |
| `id` | 稳定的反向域名插件标识，同时用于 API 路径和数据归属。发布后沿用。 |
| `name` | 操作者看到的名称。主展示字段使用英文，本地化文本放入 `locales`。 |
| `version` | 插件自身的语义化版本。 |
| `minHostVersion` | 最低 Extension Host 版本，Web 与 Lua 插件可选，原生插件必填。按语义化版本与宿主版本比较，可用 `ext version` 查看独立宿主版本；嵌入模式使用实际嵌入的版本。 |
| `hostApi` | 插件兼容的 Host API 版本闭区间。当前 Host API 为 `1`。 |
| `entry.web`、`entry.lua`、`entry.native` | 可选入口，分别对应 Web、Lua 与原生可执行插件。至少声明一个。原生入口位于 `native/` 下，不能与 Lua 入口组合。 |
| `native` | 原生插件声明：`platform` 为 `linux-amd64` 或 `linux-arm64`；`exports` 为公开方法名；`webApi: true` 允许浏览器经 `/extensions/{id}/api/` 访问，且要求同时声明 `entry.web`。 |
| `config` | 可选配置字段描述，见下表。 |
| `description` | 可选的一句话英文简介。`ext validate --strict` 要求非空、单行且不超过 160 字符。 |
| `author` | 可选作者信息 `{ "name", "url"?, "email"? }`。严格模式要求 `author.name`。 |
| `license` | 可选 SPDX 许可证标识，例如 `"MIT"` 或 `"Apache-2.0"`。严格模式必填。 |
| `homepage`、`repository` | 可选项目主页与源码仓库 URL。严格模式要求 `https://`。 |
| `icon` | 可选包内相对路径图标，仅限 `.svg`、`.png`、`.webp`，单文件不超过 256 KiB。`ext pack` 与 `ext pkg` 会自动收集，宿主经 `GET /extensions/{id}/icon` 提供。 |
| `categories` | 可选 1–3 个受控分类：`database`、`proxy`、`container`、`ops`、`monitoring`、`networking`、`security`、`utility`。 |
| `keywords` | 可选最多 8 个小写 kebab-case 搜索关键词。 |
| `requirements` | 可选环境前置提示 `{ "os"?, "commands"?, "systemd"? }`。它只用于展示和安装前提醒，不强制拦截，也不声明权限。 |
| `locales` | 可选按 BCP-47 语言标签索引的本地化覆盖，可覆盖 `name`、`description` 和 `config.<key>.label` / `description`。 |

### 配置字段

| 字段 | 含义 |
| --- | --- |
| `type` | `string`、`number` 或 `boolean`。 |
| `required` | 是否为必填项。 |
| `secret` | 仅用于字符串。标记为 `secret` 的值可供插件后端读取，但不出现在管理响应和宿主日志中。 |
| `default` | 默认值。 |
| `format` | `integer` 要求 `number`；`writable-directory` 要求非密钥字符串，保存时宿主会校验宿主机绝对路径的目录可写。 |
| `min`、`max` | 仅用于 `number`，为闭区间。 |
| `label`、`description` | 英文显示标题与帮助说明；缺失时回退显示字段键名。`locales` 可覆盖。 |

### 命名规则

- 作者自有正式插件使用真实持有的域名，例如 `de.jianwang.<slug>`。
- 教学与能力示例使用 RFC 2606 保留域 `com.example.<slug>`，例如 `com.example.hello`、`com.example.worker`。
- 第三方市场插件使用自己拥有所有权的反向域名前缀。
- 默认解析与校验允许历史下划线和两段式 ID；`ext validate --strict` 与市场索引要求至少三段、每段小写 kebab-case（`[a-z0-9-]`，首尾为字母或数字，禁止连续 `--` 与下划线）。`com.example.*` 与 `com.godesk.*` 不能上架公共或官方市场。
- `config` 键名在严格模式下必须为英文 camelCase，`locales` 引用的配置键必须存在于顶层 `config` 中。

ZIP 中的绝对路径、`..`、反斜杠、符号链接和重复路径都会被拒绝。当前限制为单文件 64 MiB、总计 256 MiB、最多 4096 个文件。

## 生命周期与存储

| 操作 | 契约 |
| --- | --- |
| 安装 | 校验并发布插件包，持久化安装记录。新安装处于未启用状态。已有同 ID 插件时返回 `409`（`code: "already_installed"`, `pluginId`）。 |
| 升级 | 原地替换已安装插件包，保留现有配置（含 `secret`）与业务 SQLite 库；允许同版本覆盖与降级。若插件当前已启用，替换后自动重启；若重启失败仍返回 `200`，状态为「已启用，启动失败」。 |
| 启用 | 持久化启用意图并启动。启动失败显示错误及重试入口，启用意图仍有效。 |
| 启动 | 为已启用插件创建当前进程的插件实例。重复启动收敛到同一个实例。 |
| 停止 | 停止当前实例并关闭其连接、订阅和任务，保留启用意图。可手动再启动，宿主下次启动也会恢复。 |
| 禁用 | 清除启用意图并停止实例。宿主重启后继续处于禁用状态。 |
| 卸载 | 先禁用并释放资源，再移除包和配置。默认保留业务数据，显式选择清除时再删除业务库。 |
| 关闭窗口 | 释放该窗口的连接和订阅，插件实例继续随宿主运行。 |

管理界面分别显示持久化的启用意图与当前实例状态，例如「已启用，启动失败」。同一个插件的生命周期操作依序处理。管理界面提供插件在线日志查看与原地升级。

Extension Host 在独立数据目录里管理宿主状态和每个插件的业务 SQLite：

```text
<data-dir>/
  host.db                              安装记录、启用意图和配置
  packages/                            已发布的插件包
  plugins/<id>/business.db             插件业务 SQLite
  plugins/<id>/data/                   host.dataDir
  logs/by-plugin/<id>/<version>.log    插件日志
```

GoDesk 的 `godesk.db` 继续保存操作者和内置应用设置。[SQLite 架构决策](adr/0005-use-sqlite-for-persistent-state.md)

## Lua 与主机能力

每个运行中的 Lua 插件有自己的 GopherLua `LState`。一个 goroutine 管理该状态。入口装载后注册请求处理器和所需的生命周期钩子。Host 调用通过上下文传递取消，停止或重载时关闭该实例拥有的连接和任务。 [GopherLua](https://github.com/yuin/gopher-lua)

两种模式默认提供 GopherLua 的 `os` 和 `io` 标准库，包括 `os.execute`、`io.popen` 和 `os.setenv`。`os.setenv` 修改当前宿主进程的环境。`os.execute` 同步等待命令结束，同一实例的 Lua 请求串行处理。需要在任务运行期间继续响应状态查询时，插件可以通过短时命令提交后台任务。宿主提供插件数据目录，插件自行组织文件路径。`require` 从包内或 Host 预装模块加载。`print` 进入插件日志。 [GopherLua](https://github.com/yuin/gopher-lua)

`os.exit([code])` 结束当前插件实例，关闭该实例的订阅并释放 Lua 和插件 SQLite。调用会中断当前 Lua 执行，宿主随后运行已注册的停止钩子。退出后状态为「已启用、已停止」。可手动启动，宿主重启时按启用设置恢复。退出码记录在插件日志中。

| Host API 模块 | 首版职责 |
| --- | --- |
| `host.app` | 注册当前插件的 HTTP 处理器和生命周期钩子，向当前插件的浏览器订阅发布事件。 |
| `host.http` | 发起 HTTP 和 HTTPS 请求。 |
| `host.ws` | 尚未实现。 |
| `host.storage` | 访问当前插件业务 SQLite。 |
| `host.fs` | 以宿主账号权限执行文件与目录操作，包括读取、写入、列目录和删除。 |
| `host.process` | 异步启动子进程、同步执行命令或流式读取输出，并把结果交回当前 Lua 实例。 |
| `host.schedule` | 注册当前插件实例的定时任务，回调在实例的 Lua 执行队列中运行。 |
| `host.services` | 列出、查询、启动、停止、重启 systemd 服务及读取日志。 |
| `host.config`、`host.json` | 读取配置，编码和解码 JSON。 |

服务查询和日志以 GoDesk 运行账号执行。启停和重启默认也使用该账号。插件可传入 `{ sudo = true }`，让非 root 宿主通过非交互 sudo 执行。系统权限决定操作是否获准。 [GoDesk 服务契约](services.md#权限)

### 异步进程

`host.process.start(program, args, onExit[, env])` 使用独立的参数数组启动命令并立即返回子进程 PID。命令继承宿主运行账号和环境。可选的 `env` 表仅修改子进程环境，用字符串设置变量，用 `false` 移除继承的变量。启动失败时返回 `nil, error`。`onExit(result)` 在实例的 Lua 执行队列中运行，和 HTTP 处理器串行执行。即使浏览器页面已关闭，回调仍会在运行中的插件内执行。

结果包含 `pid`、`exitCode` 和 `stderr`。标准输出默认丢弃，命令可自行把产物写到文件。`stderr` 保留开头 64 KiB，截断时设置 `stderrTruncated`。调用方可以使用 `error` 查看等待进程时的错误。停止实例会终止其子进程，完成回调随实例结束。插件负责在重新启动时处理上次中断的业务任务。

`host.process.exec(program, args[, options])` 等待命令退出并返回 `stdout`、`stderr` 和退出码；在可挂起的 HTTP 处理器中等待期间不阻塞同一插件的其他请求。`host.process.spawn(program, args[, options])` 以流式回调交付输出并返回可停止的进程句柄。`host.process.lookPath(name)` 解析可执行文件路径。完整参数和结果字段见 [Extension Host README](https://github.com/EziosWJ/Extension-Host/blob/main/README.md#hostprocess)。

### 定时任务

`host.schedule.register(name, expression, fn)` 注册或替换当前插件实例的定时任务，`host.schedule.unregister(name)` 移除任务。`expression` 支持标准 5 段 cron（分 时 日 月 周）或 `@every <duration>`（例如 `@every 30m`），按宿主进程的本地时区解释。回调在该实例的 Lua 执行队列中运行，与 HTTP 处理器和进程回调串行，必须尽快返回；耗时工作应交给 `host.process`。同一任务上一次回调未返回时跳过本次触发并记录警告。回调错误写入插件日志，不自动重试。

注册只在实例运行期间有效。停止、禁用或卸载实例会清除注册；宿主重启后按启用设置恢复实例，插件需要在启动钩子中按自己持久化的设置重新注册。宿主停止期间错过的执行不补跑。名称或表达式无效时返回 `nil, error`；重复注册同名任务会替换旧任务。

## Web、HTTP 与 WebSocket

GoDesk 和独立管理界面以同源 iframe 装载插件 Web 入口。业务前端直接使用原生 `fetch` 和 `WebSocket`。可复用现有前端框架，构建产物使用相对资源路径。框架需要前端路由时，首版可使用 hash 路由。

| 路径 | 用途 |
| --- | --- |
| `GET /api/v1/extensions` | 返回已安装插件列表。 |
| `POST /api/v1/extensions` | 上传 ZIP 安装插件。支持 `multipart/form-data` 的 `package`/`file` 字段或原始 ZIP 请求体；若已安装同 ID 插件返回 `409`（`code: "already_installed"`, `pluginId`）。 |
| `GET /api/v1/extensions/{id}` | 读取单个插件详情。 |
| `GET /api/v1/extensions/{id}/logs` | 读取插件最近日志，支持可选查询参数 `lines`（`1..1000`，默认 `200`），返回 `{"lines": [...]}`。 |
| `POST /api/v1/extensions/{id}/upgrade` | 上传 ZIP 原地升级指定插件，保留配置（含密钥）与业务数据；包 ID 不匹配时返回 `400`（`code: "id_mismatch"`）。 |
| `POST /api/v1/extensions/{id}/enable` | 持久化启用意图并启动。 |
| `POST /api/v1/extensions/{id}/start` | 启动已启用插件。 |
| `POST /api/v1/extensions/{id}/stop` | 停止实例，保留启用意图。 |
| `POST /api/v1/extensions/{id}/disable` | 清除启用意图并停止。 |
| `PUT /api/v1/extensions/{id}/config` | 合并并校验配置。 |
| `DELETE /api/v1/extensions/{id}` | 卸载插件；`?purge=true` 同时删除业务数据。 |
| `GET /extensions/{id}/icon` | 已安装插件声明的图标文件；插件停止、禁用或未声明 `entry.web` 时仍可访问。 |
| `GET /extensions/{id}/web/` | 插件 Web 入口和资源。 |
| `/extensions/{id}/api/` | 当前插件注册的 Lua 业务路由，或声明了 `native.webApi` 的原生后端。 |
| `GET /extensions/{id}/events` | 当前插件到浏览器的 WebSocket 事件流。 |

插件启用并启动后，Web、API 和事件路由才可用；停止、禁用或启动失败时返回 `409`。管理 API 始终可用。

管理 API 的错误响应为 `{"code": "...", "message": "..."}`。重复安装返回 `409 already_installed`，另含 `pluginId`；日志参数无效返回 `400 invalid_lines`；日志内容或编码后的响应超过 2 MiB 返回 `413 log_tail_too_large`；无效的 ZIP 或 Manifest 返回 `400 invalid_package`；不兼容的包返回 `400 incompatible_package`；升级包 ID 与路径不符返回 `400 id_mismatch`；读取或升级未安装的插件返回 `404 not_found`。其他宿主错误使用 `conflict`、`host_closed`、`internal_error` 等 code。

### GoDesk 扩展管理界面

- **在线日志**：每个已安装插件行提供「日志」入口，打开日志弹窗调用 `GET /api/v1/extensions/{id}/logs?lines=200`。支持手动刷新、行内关键词搜索（不区分大小写并高亮匹配计数）、自动换行切换与一键复制；首版不提供实时流式尾随。
- **原地升级（双入口）**：
  - 顶部「安装 ZIP」：提交 `POST /api/v1/extensions` 返回 `409 already_installed` 时，界面自动识别已安装插件并弹出升级确认框。
  - 单行「升级」：为指定插件选择 ZIP 后弹出升级确认框。
  - 确认框会尽量在本地读取 ZIP 根目录 `manifest.json` 以展示旧版本到新版本的变更，同版本覆盖或降级时给出温和提示，确认后调用 `POST /api/v1/extensions/{id}/upgrade` 并反馈升级及重启结果。

双模式路径一致。嵌入模式将这些入口接入 GoDesk 会话验证。插件启用和启动后可以访问其运行入口，停止或禁用后宿主关闭该实例的现有事件订阅。窗口关闭只结束该窗口的订阅。插件在自己的命名空间下定义业务请求、响应和事件内容。Host 根据当前路由选择插件实例，并处理包不存在、实例未运行和实例执行失败等宿主级错误。

## 独立开发命令

安装已发布的 `ext`：

```sh
CGO_ENABLED=0 go install github.com/EziosWJ/Extension-Host/cmd/ext@<版本标签>
```

| 命令 | 行为 |
| --- | --- |
| `ext` / `ext serve` | 启动宿主和管理页。参数：`--listen`（默认 `127.0.0.1:5001`）、`--data-dir`（默认 `./ext-data`）。 |
| `ext run <dir\|zip>` | 安装、启用并运行一个插件，然后启动宿主。参数同 `serve`。 |
| `ext version` | 查看 Extension Host 版本。 |
| `ext init` | 选择模板，并在当前目录下创建以插件名称命名的项目文件夹。 |
| `ext dev` | 自动安装并启用当前目录的插件，保存文件后更新，使用项目的 `.ext/` 保存设置、数据和日志。支持 `--listen`。 |
| `ext validate [--strict] <dir\|zip>` | 校验 Manifest、入口、Host API 兼容性和包结构。`--strict` 执行市场准入校验，选项可放在路径前后。 |
| `ext pack <dir> [-o file]` | 校验后打包，默认输出 `dist/<id>-<version>.zip`；原生包名附加目标平台。 |
| `ext pkg` | 校验当前项目并把运行文件打包到 `dist/`。 |
| `ext logs [plugin-id]` | 读取插件日志。支持 `--data-dir <dir>`、`-n` / `--lines <N>`（默认 100 行，`0` 显示全部）和 `-f` / `--follow`。 |

`ext init` 提供「网页 + Lua」「只有网页」「只有 Lua」「网页 + 原生后端」「只有原生后端」五种模板。原生模板附带 Go 后端源码、`go.mod` 和 `Makefile`，先构建出 `native/plugin`，再运行 `ext dev` 或 `ext pkg`。`backend/`、`go.mod` 和 `Makefile` 不进入 ZIP。

`ext dev` 启动后自动安装并启用当前项目。网页资源变化时刷新浏览器；Lua、`native/` 运行产物、`manifest.json` 或声明的 `icon` 变化时，宿主检查并重启插件。更新失败会显示原因，之前能运行的版本继续提供服务。开发数据保存在 `.ext/`，日志在 `.ext/logs/`。

`ext validate --strict` 检查三段式 kebab-case ID 与保留前缀、必填市场元数据、`https://` URL、`icon` 文件存在性与大小、英文 camelCase 配置键、`locales` 引用以及 `requirements` 白名单结构。`com.example.*` 示例可用于本地开发，但不能通过严格模式上架市场。

`ext logs` 从数据目录的 `logs/` 读取。当前目录有 `manifest.json` 和 `.ext/logs/` 时默认使用 `.ext/`，其余情况默认使用 `./ext-data`。省略插件 ID 时优先使用当前目录 Manifest 中的 ID，其次读取唯一的日志文件。

```sh
ext logs -f
ext logs com.example.hello --data-dir ./ext-data --lines 50
```

`ext run` 会安装、启用并启动指定插件，然后提供管理页。若同一 ID 已安装，会先卸载再重新安装：业务数据默认保留，插件配置恢复为 Manifest 默认值。`ext dev` 使用 `.ext/`，`serve` 和 `run` 默认使用 `./ext-data`。

## PostgreSQL 备份参考插件

PostgreSQL 备份示例已拆分为独立插件仓库 `ext-postgres-backup`，插件 ID 为 `de.jianwang.postgres-backup`。它面向部署者配置的一个数据库，提供「立即备份」、定时「备份计划」和「备份历史」。Lua 使用 `host.process.start` 直接启动 PostgreSQL 的 `pg_dump`，提交后立即返回任务状态，完成回调写入插件自己的 SQLite。同一插件实例同时运行一条备份任务。GoDesk 用于正常运行，独立 `ext` 用于开发联调，两者各自保存任务历史和备份产物。

数据库地址、端口、数据库名、用户和可选密码可从插件页面保存到本地 SQLite。保存后新任务使用页面配置，已有任务继续使用启动时的参数。保存的密码不会通过页面接口读回。备份计划以 cron 或 `@every` 表达式保存在同一个业务库，实例启动时重新注册；只在实例运行期间触发，宿主停止期间错过的执行不补跑。定时备份与手动备份共用同一条「运行中」保护。

## 从源码联调 GoDesk

常规开发只需克隆 GoDesk。没有本地工作区时，直接运行 `make dev`，Go 会使用 `backend/go.mod` 中固定的 Extension Host 版本。

要用本机的 Extension Host 源码联调，将两个仓库放在同一父目录。如果 GoDesk 根目录还没有 `go.work`，从该目录执行一次：

```sh
GOWORK=off go work init ./backend ../Extension-Host
make dev
```

之后运行 `make dev` 或 `make build` 都会使用同级的 Extension Host 源码，包括未提交的改动。修改 Host 的 Go 代码后，重启开发进程即可生效。`go.work` 和 `go.work.sum` 由 Git 忽略。

已有工作区时，可以用 `GOWORK=off make dev` 临时切回固定版本。要在本地按固定版本生成发布二进制，运行 `GOWORK=off make build`。
