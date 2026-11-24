# 从独立 Go 模块嵌入 Extension Host

GoDesk Extension Host 需要独立构建、运行和发布，同时 GoDesk 需要保留现有单二进制部署。Extension Host 使用独立 Go 模块，提供公共运行引擎和通用主机能力。GoDesk 导入库并复用自身 HTTP 监听器和操作者会话，`godesk-ext` 用同一引擎独立装配。依赖方向固定为 `GoDesk → Extension Host`。 [Extension Host 仓库](https://github.com/EziosWJ/Extension-Host)

独立服务加远程调用会增加 GoDesk 部署和生命周期管理成本。共享库保留单进程部署，插件也与宿主共享进程故障范围。GoDesk 保有认证、桌面和 `godesk.db`，Extension Host 保有自身插件状态和存储。通用主机能力随实际需求逐项迁移，GoDesk 原生应用直接调用这些 Go 包。

联合开发使用本地 `go.work`。GoDesk 发布固定依赖已发布的 Extension Host 模块版本，两个仓库各自在 `GOWORK=off` 下构建。首版行为和迁移次序见[插件契约](../extensions.md)与[实施 Spec](../../.scratch/extension-host/spec.md)。
