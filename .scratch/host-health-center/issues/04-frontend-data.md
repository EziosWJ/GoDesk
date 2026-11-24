# 04 · 前端健康数据层

Status: ready-for-human

为底栏提供 5 秒轮询的健康状态数据层。

## 范围

- 新增 `frontend/src/health.ts`：契约类型、`healthApi.status()`。
- 新增 `frontend/src/useHostHealth.ts`：5 秒轮询、页面不可见暂停、恢复可见/窗口聚焦立即刷新、同一时间单请求并取消过期响应。
- 连接状态 `connecting` / `connected` / `disconnected`：连续 3 次失败或超过 15 秒无成功响应才显示中断；短暂失败保持上一次状态。
- 连接恢复后自动刷新；`online` 事件只用于重试，不推断主机健康。
- API 成功但顶层 `stale=true` 时仍视为 `connected`，由展示层按「状态未知 / 数据未更新」处理。

## 验收

- `pnpm --dir frontend lint`、`pnpm --dir frontend build` 通过。

## Comments

- 2026-11-24：实现完成。新增 `health.ts` 与 `useHostHealth`：5 秒轮询、页面不可见暂停、同时间单请求并取消过期响应、连续 3 次失败或 15 秒无成功才显示中断、恢复后自动刷新；`online`/`focus` 只触发重试；API 成功但顶层 `stale` 时连接状态仍为 `connected`。