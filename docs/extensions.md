# GoDesk Extension Host 首版契约

本文定义首版计划交付的共同行为。共享宿主侧（Extension Host 的 `hostsys/services` 与 `host.services` 服务授权）已实现；Mihomo 示例插件和独立开发命令留待工单 04–05 完成。实施顺序、迁移边界和通过条件见[实施 Spec](../.scratch/extension-host/spec.md)。

## 运行模式与信任

Extension Host 由独立仓库 [EziosWJ/Extension-Host](https://github.com/EziosWJ/Extension-Host) 交付。该仓库拥有插件运行引擎、独立命令 `godesk-ext` 和按需从 GoDesk 抽取的通用主机能力。首版优先共享 systemd 实现。

| 模式 | 入口与运行环境 |
| --- | --- |
| 嵌入 | GoDesk 导入 Extension Host，在现有 Go 进程和 HTTP 监听器内挂载其 handler，使用当前操作者会话。开始菜单的「扩展」入口提供插件列表和窗口。 |
| 独立 | `godesk-ext` 装配同一引擎并提供最小管理界面，默认监听本机回环地址，面向单操作者。运行通用插件时无需 GoDesk 源码、程序、登录或数据库。Mihomo 等外部服务按插件自身的部署要求准备。 |

两个入口使用相同的 Manifest、插件生命周期、数据格式和 HTTP/WS 契约。GoDesk 与 `godesk-ext` 可分别指定数据目录。同一插件包可以在两个入口运行，各进程管理自己的运行状态。

首版面向部署者主动信任并安装的第三方插件。Web 插件与宿主同源，其脚本可以访问父页面并使用当前浏览器会话调用宿主 API。Lua 与宿主共用进程，标准文件 I/O 使用宿主 Linux 运行账号权限，包括该账号可访问的其他目录。能力授权约束通过 Host API 发起的操作。 [GoDesk 会话契约](authentication.md) · [主机权限契约](privileges.md)

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

标准库保留常用基础函数、`string`、`table`、`math`、`coroutine`、`io` 文件读写及 `os` 的常用文件和时间操作。宿主提供插件数据目录，插件自行组织文件路径。`require` 从包内或 Host 预装模块加载。`os.exit`、`os.setenv`、`os.execute` 和 `io.popen` 关闭，`print` 进入插件日志。 [GopherLua 标准库源码](https://github.com/yuin/gopher-lua/tree/master)

| Host API 模块 | 首版职责 |
| --- | --- |
| `host.app` | 注册当前插件的 HTTP 处理器和生命周期钩子，向当前插件的浏览器订阅发布事件。 |
| `host.http` | 向已授予的目标发起 HTTP 请求。 |
| `host.ws` | 订阅已授予的目标 WebSocket，将事件交给当前插件实例。 |
| `host.storage` | 访问当前插件业务 SQLite。 |
| `host.services` | 查询和重启部署者授权的已有 systemd 服务。 |

插件身份由 Host 从运行实例取得。部署配置可把 Mihomo 的网络请求限定为指定控制地址，将服务操作限定为 `mihomo.service` 的查询与重启。服务调用默认使用运行账号，部署者可为指定动作显式选择非交互 sudo。GoDesk 原生服务管理继续遵守自身权限契约。 [GoDesk 服务契约](services.md#权限)

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
