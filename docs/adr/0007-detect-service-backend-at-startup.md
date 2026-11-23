# 服务管理在启动时探测后端

goDesk 的服务管理面向被管理主机的 system 级服务。首版只实现 systemd，但按 OpenRC 和 BusyBox init 的扩展需求设计：进程启动时探测一次可用后端（systemd → OpenRC → BusyBox init → none），把结果固定为 `Backend` 接口实例。接口只包含列表、启停重启、enable/disable 和读取日志，并用 `Capabilities` 声明后端整体支持的动作与状态可靠性。每个服务的可用动作由后端按当前状态计算，前端只渲染后端返回的动作，不按后端名称写分支。探测不到后端时返回 `none`，不阻止 goDesk 启动。

systemd 实现直接执行 `systemctl` / `journalctl`，不接 D-Bus。列表使用 `list-unit-files` 和 `list-units` 的固定列；需要单单元属性时用 `show -p`，不解析 `systemctl status` 的人类可读文本，避免依赖较新版本才有的 JSON 输出。命令不经过 shell，单元名严格校验并在参数前加 `--`。服务操作不引入单独的提权机制，权限就是运行 goDesk 的账号权限；完整功能需要在部署时以 root 运行或给该账号配置 polkit 和 journal 读取权限。这样与文件管理、终端现有的账号权限模型一致，应用本身不保存或提升权限。

替代方案：每次请求探测后端会把探测成本摊到每个请求，且 PID 1 在进程生命周期内不会变化，收益为零；只用配置不探测需要部署者知道后端类型，违背单二进制即开即用的目标；应用内调用 sudo 或安装 setuid helper 会增加部署步骤和新的提权面；D-Bus 直连在旧 systemd 上仍要处理属性差异，且首版只需要稳定的命令输出。等 OpenRC/BusyBox 真正实现时再根据第二套实现校准接口，不在首版做“大一统”服务模型。
