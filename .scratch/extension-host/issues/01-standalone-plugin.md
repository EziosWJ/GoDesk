# 01 · 独立运行示例插件

Status: ready-for-agent
Blocked by: None

## 交付内容

在独立的 [Extension-Host 仓库](https://github.com/EziosWJ/Extension-Host)实现 `godesk-ext` 和共享运行引擎。操作者在本机管理页安装并启用一份最小的 Web + Lua 示例 ZIP，打开页面调用 Lua、接收实时事件，并在重启后读到已保存的数据。示例 ZIP 也用于后续 GoDesk 嵌入验收。 [实施 Spec A](../spec.md#a-独立运行闭环) · [首版契约](../../../docs/extensions.md)

## 验收

- [ ] 只检出 Extension-Host，在 `GOWORK=off CGO_ENABLED=0` 下构建。在没有 GoDesk 程序、登录和数据目录的环境中启动 `godesk-ext` 并打开本机管理页。
- [ ] `pack` 生成标准 ZIP，`validate` 校验目录和 ZIP，`run` 能运行目录或 ZIP。对无效包路径、缺失入口和不兼容版本给出明确错误。
- [ ] 安装后显示未启用。启用后，示例 Web 页面用原生 HTTP 调用 Lua、用原生 WebSocket 接收事件，并读写插件业务 SQLite。Web-only 和 Lua-only 示例分别可运行。
- [ ] 重启宿主可恢复已启用插件及数据。停止保留启用意图，禁用取消自动恢复。启动错误可定位且可重试。卸载默认保留业务数据，显式清除后再安装时使用空库。
- [ ] 关闭页面结束对应订阅，停止插件或关闭宿主释放对应连接和任务。未获授权的 Host API 调用返回明确错误。
