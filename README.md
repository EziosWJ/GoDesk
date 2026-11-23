# goDesk

goDesk 是面向单台 Linux 主机和一位操作者的 Web 桌面项目。当前版本提供桌面前端、操作者认证、主机文件管理、文本编辑和 SQLite 就绪检查。

![goDesk 桌面与文件管理器](frontend/docs/screenshots/desktop-light.png)

## 当前功能

- 首次访问时创建操作者密码。登录会话持续 7 天，关闭浏览器或重启服务后可继续使用有效会话。
- 文件管理器、文本编辑器和终端使用运行 goDesk 的账号权限操作 Linux 主机。终端支持多窗口和后台会话，关闭窗口后可重新接回。系统监控、服务管理和主机设置仍使用示例逻辑，后续实现范围见 [首版规格](.scratch/backend-v1/spec.md)。
- 发布构建将前端资源嵌入 Go 二进制，由同一个进程提供桌面、认证接口、文件接口和健康检查。

## 项目结构

- `frontend/` 包含 React、TypeScript 和 Vite 前端，源自 [React Web Desktop 脚手架](https://github.com/EziosWJ/react-web-desktop)。
- `backend/` 包含 Go 模块、HTTP 服务、SQLite 连接和前端资源嵌入代码。
- `docs/adr/` 保存项目的 [架构决策记录](docs/adr/)。

## 本地开发

开发和完整构建使用 Linux、Go 1.26、Node.js 24、pnpm 12 和 GNU Make。从项目根目录运行以下命令。

```sh
git clone https://github.com/EziosWJ/GoDesk.git
cd GoDesk
pnpm --dir frontend install --frozen-lockfile
make dev
```

打开 Vite 输出的地址，默认是 `http://localhost:5173`。Vite 将 `/api` 请求转发到 `127.0.0.1:8080`，Go 服务的健康检查可用 `curl -fsS http://localhost:8080/healthz` 验证，正常时返回 `{"status":"ok"}`。按 Ctrl+C 停止两个服务。联调使用项目根目录的 `data/godesk.db`。

也可以在两个终端中分别启动前端和后端。

```sh
pnpm --dir frontend dev
go -C backend run ./cmd/godesk -data-dir ../data
```

提交前可运行以下检查。

```sh
pnpm --dir frontend lint
go -C backend test ./...
```

## 构建与运行

```sh
make build
./godesk -listen 127.0.0.1:8080 -data-dir ./data
```

在浏览器访问 `http://localhost:8080`，按提示创建密码并进入桌面。发布目标机只需与其平台匹配的 `godesk` 二进制。程序会创建数据目录和 SQLite 文件。

| 命令或选项 | 用途 |
| --- | --- |
| `make build` | 构建并嵌入静态资源，生成 `./godesk`。 |
| `make build-backend` | 生成纯后端二进制，提供认证、文件管理、终端和健康检查接口。 |
| `make help` | 列出构建和开发命令。 |
| `OUTPUT` | 覆盖二进制路径，例如 `make build OUTPUT=/tmp/godesk`。 |
| `FRONTEND_DIR` | 覆盖用于开发和构建的前端源码目录，默认为 `frontend`。 |
| `-listen` | 设置 HTTP 监听地址，默认为 `0.0.0.0:8080`。 |
| `-data-dir` | 设置持久化目录，默认为启动时工作目录下的 `./data`。 |

## 修改与重置密码

登录后，在「系统设置 → 账户」输入当前密码和两遍新密码。修改成功后当前浏览器继续登录，其他设备需重新登录。

忘记密码时，先停止服务，再在主机终端运行以下命令。将 `-data-dir` 指向服务原来使用的数据目录，按提示隐藏输入两遍新密码。重启服务后使用新密码登录。

```sh
./godesk reset-password -data-dir ./data
```

## 终端

从桌面或开始菜单打开「终端」。关闭窗口、浏览器或退出登录后，可以从「会话管理」接回仍在运行的 Shell。停止或重启 goDesk 会结束所有终端会话。回看行数在「系统设置 → 终端」中调整，默认为 5,000 行。

## 相关文档

- [认证行为与 HTTP 接口](docs/authentication.md)
- [文件管理与文本编辑契约](docs/file-management.md)
- [终端会话及接口契约](docs/terminal.md)
- [前端使用与开发说明](frontend/README.md)
- [UI 设计规范](frontend/docs/ui-design/01-design-principles.md)
- [项目术语](GLOSSARY.md)
