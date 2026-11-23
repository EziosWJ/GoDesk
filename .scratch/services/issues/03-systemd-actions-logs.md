# 03 · systemd 动作、日志与 HTTP

Status: ready-for-human

实现服务动作、日志读取、超时和错误映射，以及三个 HTTP 接口。

## 范围

- `systemctl <action> --no-ask-password -- <unit>`，动作最长 120 秒，绝不经过 shell。
- `journalctl -u <unit> -n N --no-pager --quiet -o short-iso`，默认 200 行、上限 1000。
- 动作前重新确认单元存在和动作可用；单元名严格校验。
- 错误码：400 `invalid_unit/invalid_action/invalid_lines`，403 `permission`，404 `not_found`，409 `action_not_allowed/logs_unavailable`，422 `operation_failed`，504 `timeout`。

## 验收

- fake backend 覆盖成功、所有错误码、`none` 后端、日志行数边界和超时。
- 无日志返回 200 空数组；权限错误返回 403。
- `go -C backend test ./...` 通过。

## Comments

- 2026-11-23：实现完成。`http.go` 提供列表、动作和日志路由；`systemd.go` 统一执行命令并映射 stderr。handler 测试覆盖全部分支；只读端到端验证 `GET /api/v1/services` 和 ssh.service 日志返回真实数据。
