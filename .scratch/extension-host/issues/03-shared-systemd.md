# 03 · 抽取共享 systemd 能力

Status: ready-for-agent
Blocked by: 02

## 交付内容

将 GoDesk 已有的 systemd 共享能力迁入 Extension Host。GoDesk 原生服务管理继续通过现有入口操作服务，示例插件通过同一实现查询或按授权重启已有单元。 [实施 Spec C](../spec.md#c-共享-systemd-与-mihomo-插件)

## 验收

- [ ] GoDesk 原生服务管理继续提供既有路由、响应、状态校验、错误映射和提权行为。已有服务管理测试通过。
- [ ] 示例插件在独立和嵌入模式可查询部署者授予的已有单元，并在获得重启授权时执行重启。原生服务管理和插件调用共用 Extension Host 的 systemd 实现。
- [ ] 插件默认使用运行账号执行。为指定动作配置非交互 sudo 后，只获准执行该动作的账号也能完成调用。未授权、单元缺失和 systemd 不可用时报告对应原因。
