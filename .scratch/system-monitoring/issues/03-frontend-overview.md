# 03 · 前端概览接入真实数据

Status: ready-for-human

将 `SystemMonitor.tsx` 从模拟数据改为真实指标，并新增「概览 / 端口」标签结构。

## 范围

- 新增 `src/monitor.ts` 封装 `metrics`/`ports` 接口和错误类型。
- 概览每 1 秒轮询指标接口。
- CPU/内存卡片显示当前值与 60 秒趋势；CPU 显示每核使用率。
- 磁盘列出实际挂载点、当前用量和 meter。
- 网卡显示名称、MAC、IPv4/IPv6、当前收发速率和 60 秒趋势。
- 采集未就绪时显示「正在采集」并重试；401 回到登录界面。
- 沿用内联 SVG 与原生 `meter`，不新增图表库。
- 监控窗口默认尺寸调整为 760×520。

## 验收

- 概览展示后端返回的真实数据，主题（浅色/深色）和窄窗口容器查询正常。
- `pnpm --dir frontend lint` 与 `pnpm --dir frontend build` 通过。

## Comments

- 2026-11-23：实现完成。概览接入真实指标、60 秒趋势、每核柱状条与网卡区域；窗口默认 760×520；`pnpm lint`/`pnpm build` 通过。
