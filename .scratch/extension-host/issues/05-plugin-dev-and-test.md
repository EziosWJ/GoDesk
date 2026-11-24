# 05 · 交付独立开发与测试流程

Status: ready-for-agent
Blocked by: 04

## 交付内容

插件开发者只用 `godesk-ext` 就能调试 Mihomo 插件、查看日志、运行 Mock 测试，并连接明确配置的真实 Mihomo 做 Local 测试。首轮验收覆盖全部六个插件命令。 [实施 Spec D](../spec.md#d-开发命令与首轮交付)

## 验收

- [ ] 使用 `dev` 启动插件源码。前端构建产物更新后刷新页面，Lua 校验通过后重建实例，开发 SQLite 保留。
- [ ] 用 `logs` 定位 Lua 错误，修正后可再次重载。日志按插件区分，CLI 可选择读取的运行数据目录。
- [ ] `test` 在临时 SQLite 中覆盖 Mihomo REST、WS 和服务授权场景。Mock 替换能力实现，插件仍通过真实加载器、权限判断、Lua 和网关运行。
- [ ] `test --local` 使用明确配置的真实 Mihomo 和服务能力，使用独立测试库。`dev`、`run`、`test`、`validate`、`pack`、`logs` 均可在没有 GoDesk 的环境使用。
