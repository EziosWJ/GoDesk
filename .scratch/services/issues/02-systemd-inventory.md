# 02 · systemd 清单与状态

Status: ready-for-human

实现 systemd 后端的清单读取、运行时状态合并、模板隐藏、状态/开机状态映射和可用动作计算。

## 范围

- `systemctl list-unit-files --type=service` + `list-units --type=service --all` 按单元名 join。
- 隐藏 `foo@.service` 模板，保留实例；只出现在运行时清单的 generated/transient 单元标为只读。
- `active (exited)` → `completed`，过渡态 → `unknown`；保留 `stateDetail`。
- `UnitFileState` → `enabled/disabled/static/masked/runtime/not_applicable`。
- 按状态、开机状态和能力计算 `actions`。

## 验收

- fixture 覆盖 3 列 `list-unit-files`、带空格 Description、oneshot、failed、模板和 generated 单元。
- 真实 systemd 主机上列表与 `systemctl` 一致。
- `go -C backend test ./...` 通过。

## Comments

- 2026-11-23：实现完成。`parse.go` 负责解析、合并和映射，`systemd.go` 负责命令执行；新增 fixture 单元测试和只读集成测试。WSL2 systemd 259 实测返回 202 个服务，ssh.service 状态与动作正确。
