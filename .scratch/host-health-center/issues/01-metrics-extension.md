# 01 · 指标采集扩展

Status: ready-for-human

扩展 `backend/internal/monitor` 的采集快照，使健康引擎只消费同一份指标，不重复采集。

## 范围

- `memory.available`：Linux 可用内存字节。
- `disks[].inodeUsedPercent`：inode 使用率，文件系统不提供时为 `null`。
- `network[].linkUp`、`network[].isDefaultRoute`。
- 默认路由接口通过 `/proc/net/route`、`/proc/net/ipv6_route` 只读查询；选择规则为 metric 升序、IPv4 优先、接口名升序，不调用 shell。
- 默认路由接口即使断链或没有地址也保留在 `network` 中；其余接口维持现有过滤。
- 磁盘过滤补齐契约清单（伪文件系统、临时文件系统、容器叠加层、只读镜像、loop 设备）并在健康判定前去重。
- 采集器进程内快照区分「空结果」和「采集失败」，metrics JSON 不暴露内部错误。
- 保留既有字段语义，补测试。

## 验收

- `GET /api/v1/system/metrics` 返回契约扩展字段。
- 单元测试覆盖文件系统过滤、同设备去重、默认路由解析与选择。
- `go -C backend test ./...` 通过。

## Comments

- 2026-11-24：实现完成。采集器新增 `memory.available`、`disks[].inodeUsedPercent`、`network[].linkUp`/`isDefaultRoute`；默认路由通过 `/proc/net/route` 与 `/proc/net/ipv6_route` 只读选择（metric 升序、IPv4 优先、接口名升序）；补齐文件系统过滤与同设备去重；快照内部 `Collection` 区分采集失败与空结果。新增单元测试，`go -C backend test ./...` 通过。