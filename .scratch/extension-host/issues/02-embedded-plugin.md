# 02 · GoDesk 嵌入并通过拆分验收

Status: ready-for-agent
Blocked by: 01

## 交付内容

从 [Extension-Host 仓库](https://github.com/EziosWJ/Extension-Host)发布 Go module tag，让 GoDesk 固定依赖该版本。GoDesk 通过已有登录和「扩展」入口打开 01 产生的同一份 ZIP，插件在 GoDesk 进程内使用同一引擎和现有 HTTP 监听器。 [实施 Spec B](../spec.md#b-godesk-嵌入与拆分验收)

## 验收

- [ ] 两个仓库可分别在 `GOWORK=off` 下构建。GoDesk 通过已发布 tag 解析依赖并产出单二进制，启动时使用现有 HTTP 监听器。
- [ ] 使用已有操作者会话从「扩展」列表打开同一份示例 ZIP。HTTP、WS 和 SQLite 行为与独立模式一致。嵌入模式的扩展路由受现有会话保护，开发环境代理也能访问插件资源和 WS。
- [ ] 重复打开同一插件聚焦已有窗口。关闭窗口只结束该窗口的订阅，插件实例继续运行。关闭 GoDesk 时现有扩展连接能退出。
- [ ] 扩展初始化或单插件启动失败时，GoDesk 内置功能仍可用。认证、桌面资源、终端和服务管理回归通过。
