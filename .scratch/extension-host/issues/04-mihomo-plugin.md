# 04 · 交付双模式 Mihomo 插件

Status: ready-for-agent
Blocked by: 03

## 交付内容

交付一份可以在 `godesk-ext` 和 GoDesk 中运行的 Web + Lua Mihomo ZIP。操作者连接已部署的 Mihomo 实例，在窗口里查看业务数据、实时流量和已有 `mihomo.service` 的状态，并在授权时重启服务。 [实施 Spec C](../spec.md#c-共享-systemd-与-mihomo-插件)

## 验收

- [ ] 两种模式安装同一份 ZIP 并连接部署者已准备好的 Mihomo。Web 通过 Lua 查询 REST 数据，窗口展示查询结果和连接失败原因。
- [ ] Mihomo 的 WS 流量经 Lua 和 Host 事件流显示在窗口中。关闭并重新打开窗口可以重新订阅。
- [ ] 控制地址和所需插件配置持久化到宿主 SQLite，重启后可继续使用。宿主管理响应和日志省略标记为密钥的值。
- [ ] 查询已有 `mihomo.service` 的状态，并在授权时重启。无授权、单元缺失或重启失败时，界面显示对应原因。
- [ ] 以部署者已有的 Mihomo 二进制、配置和 unit 验收。服务部署和 unit 模板按 Spec 留到后续交付。
