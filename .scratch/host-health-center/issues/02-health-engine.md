# 02 · 健康引擎

Status: ready-for-human

在 `backend/internal/health` 实现健康引擎，消费指标采集快照并维护持续判定状态。

## 范围

- 阈值：CPU 85/95、持续 5 分钟；内存 85/95（已用比例 = 100 - available/total）、持续 2 分钟；磁盘容量/inode 85/95、连续 2 次有效采样。
- 迟滞恢复：CPU/内存恢复阈值 90/80、恢复窗口 60 秒；磁盘 90/80、连续 2 次有效采样；允许严重直接恢复为正常。
- 采集缺口暂停计时，缺口超过新鲜度期限时放弃累计；数据过期标记 `unknown/stale`。
- 首份有效样本到达后需满足持续条件才进入警告/严重；恢复后重新累计。
- 磁盘同挂载点合并容量与 inode，取更严重维度；inode 不可用不影响容量判定。
- 网络只检查默认路由接口：断链 `critical/link_down`，无地址 `warning/no_address`，无默认路由 `applicable=false/no_default_route`。
- 聚合 `summary` 计数不变量与 `overall` 优先级 `critical > warning > unknown > healthy`。
- 状态、持续时间与 `since` 仅保存在进程内存；检查项按类别和 ID 稳定排序。

## 验收

- 单元测试覆盖阈值、持续窗口、恢复迟滞、采集缺口、过期、首份样本、inode 合并、网络判定、统计不变量与排序。
- `go -C backend test ./...` 通过。

## Comments

- 2026-11-24：实现完成。新增 `backend/internal/health`：阈值与持续窗口、恢复迟滞、采集缺口暂停与重置、过期与 `unknown` 原因、磁盘 inode 合并、默认路由网络判定、`summary`/`overall` 聚合与稳定排序；状态仅保存在进程内存。新增状态机测试与真实采集器集成测试。