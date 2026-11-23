# 02 · 后端端口占用接口

Status: ready-for-human

实现 `GET /api/v1/system/ports`，按需扫描 TCP 监听和 UDP 绑定端口。

## 范围

- 过滤 `AF_INET`/`AF_INET6`：TCP 只保留 `LISTEN`，UDP 保留已绑定本地端口的 socket。
- 返回协议、地址、端口、PID 和进程名；PID/进程名无权限读取时省略。
- 进程名读取 `/proc/<pid>/comm`，不提升权限。
- 数组按端口升序返回。
- 整体扫描失败返回 `500` JSON 错误。

## 验收

- 单元测试启动本地 TCP/UDP 监听，断言端口出现在结果中并归属当前测试进程。
- 需要登录，未登录返回 `401`。
- `go -C backend test ./...` 通过。

## Comments

- 2026-11-23：实现完成。端口接口列出 TCP `LISTEN` 与 UDP 绑定端口，进程名/PID 尽力归因；实测 26 个端口、14 个带归属，godesk 自身端口可归因。
