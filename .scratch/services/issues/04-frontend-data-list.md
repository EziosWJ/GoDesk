# 04 · 前端列表、搜索与轮询

Status: ready-for-human

新增前端 API 客户端，替换服务管理的模拟列表，接入真实数据、搜索、筛选和轮询。

## 范围

- `frontend/src/services.ts`：列表、动作和日志请求，`ServiceError` 带 code/status。
- 服务窗口打开时加载；未最小化且页面可见时每 10 秒轮询；支持手动刷新。
- 状态筛选（运行中/已完成/已停止/失败/未知）和客户端搜索（名称 + 描述）。
- 副标题由后端名驱动；`none` 显示空状态；`stateReliable=false` 显示提示。
- 移除 `initialServices` 和 impact 模拟数据。

## 验收

- 真实 systemd 后端下列表、搜索、筛选和轮询正常。
- `none` 后端显示空状态，不发起动作。
- `pnpm --dir frontend lint` 和 `tsc -b` 通过。

## Comments

- 2026-11-23：实现完成。新增 `services.ts`；`Services.tsx` 改为真实数据；`App.tsx` 把窗口可见性传给服务管理。lint、类型检查和 Vite 构建通过。
