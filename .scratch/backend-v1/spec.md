# goDesk 首版后端框架 Spec

## 目标

goDesk 首版面向一台 Linux 被管理主机和一位操作者。后端以普通主机账号运行，在一个 Go 进程中提供登录、文件管理、终端、系统监控和系统设置接口。`frontend/` 复用独立脚手架 `edgedesk-web` 的代码。生产构建将前端静态产物嵌入 Go 二进制，同源提供页面和 API。

## 技术选型

| 用途 | 选型 |
| --- | --- |
| HTTP 服务与路由 | Go 1.26、`net/http`、`http.ServeMux` |
| 本地持久化 | `database/sql`、`modernc.org/sqlite`、版本化 SQL 迁移 |
| 登录凭证 | `github.com/golang-jwt/jwt/v5` |
| 主机终端 | `os/exec`、`github.com/creack/pty`、`github.com/coder/websocket` |
| 系统指标和网卡地址 | `github.com/shirou/gopsutil/v4`、标准库 `net` |
| 文件操作 | 标准库 `os`、`io`、`path/filepath` 和 `golang.org/x/sys/unix` 的 Linux 无覆盖重命名 |
| 生产前端产物 | 标准库 `embed`、`io/fs`、`net/http` |

## 首版功能

- **初始化与登录**。首次访问未初始化实例时设置密码并自动登录。密码哈希和 JWT 签名密钥保存在 SQLite。有效期 7 天的 JWT 通过持久 `HttpOnly` Cookie 携带，关闭浏览器或重启 goDesk 后仍可恢复登录。支持网页改密、退出和 CLI 重置密码。行为与接口见 [认证文档](../../docs/authentication.md)。
- **文件管理器**。浏览目录、创建目录、上传、下载、重命名、复制、移动和永久删除。使用主机绝对路径，操作权限取决于运行 goDesk 的 Linux 账号。上传和下载使用流式传输。文本编辑器与文件管理器共用主机文件。交互、失败处理和接口见 [文件管理契约](../../docs/file-management.md)。
- **终端**。每个会话通过 PTY 运行独立的主机 Shell，窗口支持多开和独立最小化。关闭窗口、退出登录或断网时保留会话，操作者可以从会话管理接回、改名、接管或结束会话。goDesk 停止时结束全部会话。系统设置可调整新建会话的回看行数，默认为 5,000 行。生命周期和接口见[终端文档](../../docs/terminal.md)。
- **系统监控**。每秒采集 CPU、内存、磁盘用量和网卡收发速率，保留最近一分钟的采样供前端轮询。每块网卡同时提供名称、MAC、IPv4 和 IPv6 地址。提供端口占用视图，列出 TCP 监听和 UDP 绑定端口，尽力标注归属进程。行为与接口见[系统监控契约](../../docs/system-monitoring.md)。
- **系统设置**。后端读取网络、主机名、系统版本、运行时长和当前时区。网络、主机和时区在前端提供可编辑表单，保存时提示主机写入功能将在后续提供。主题与显示语言按浏览器保存。

## 服务结构

- `backend/cmd/godesk` 是服务入口，负责启动参数、SQLite 连接、HTTP 服务和退出处理。
- `backend/internal/httpserver` 集中注册路由，并对文件接口接入统一的登录校验。各功能随实际实现拆为 `backend/internal/` 下的独立包。
- 业务 API 使用 `/api/v1`，普通请求以 JSON 为主，文件传输和终端分别使用 HTTP 数据流和 WebSocket。登录校验覆盖业务 API 和终端连接，初始化、登录和健康检查入口可在登录前访问。
- 默认监听 `0.0.0.0:8080`，用 `-listen` 覆盖。默认数据目录是 `./data`，用 `-data-dir` 覆盖，SQLite 文件名为 `godesk.db`。

## 本地开发

`make dev` 同时运行 Vite 和 `go -C backend run ./cmd/godesk -data-dir ../data`。前端默认使用 `http://localhost:5173`，后端健康检查位于 `http://localhost:8080/healthz`，两个服务共用一个终端，按 Ctrl+C 一起停止。`FRONTEND_DIR` 可覆盖前端目录，`make help` 可以查看可用命令。

## 发布构建

`make build` 使用 pnpm 构建 `frontend/`，将静态产物输出到 `backend/internal/webui/dist`，逐个比较 gzip 和原始文件大小，通过 `go:embed` 将每个文件较小的版本打入 `./godesk`。服务从 `/` 提供桌面，客户端接受 gzip 时直接返回压缩资源，其余客户端可获取原始内容。可通过 `FRONTEND_DIR` 指定前端目录，通过 `OUTPUT` 指定二进制路径。发布机只需要 Go 二进制，Node.js、pnpm 和前端依赖用于构建。

`make build` 和 `make build-backend` 都使用 `CGO_ENABLED=0`、`-trimpath` 和 `-ldflags="-s -w"`，裁剪本机构建路径、符号表和 DWARF 调试信息。`make build-backend` 生成独立后端。

## 本次初始化的验收条件

项目具备 `go.mod`、服务入口和可用的 SQLite 驱动。启动时创建数据目录并验证数据库连接，`GET /healthz` 返回服务和数据库的就绪状态，收到退出信号时正常停止 HTTP 服务。通过 `CGO_ENABLED=0` 构建并完成启动、健康检查和关闭验证。发布构建从同一服务提供嵌入的桌面，业务接口随首版功能实现接入。
