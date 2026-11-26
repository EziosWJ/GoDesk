# Codex 与 Claude Code 本机 CLI 调用指南

本文记录本机 `codex` 与 `claude` 两个 CLI 的实测路径、非交互调用方式、模型与思考强度控制参数及常见注意事项，供日常直接调用或由主控 Agent 编排派单时复用。

---

## 1. Codex CLI

- **二进制路径**：`/home/wangjian/.nvm/versions/node/v24.16.0/bin/codex`（已在 `PATH` 中，可直接运行 `codex`）
- **实测版本**：`OpenAI Codex v0.169.1`
- **默认约定配置**：
  - 模型：`-m gpt-6.2-sol`
  - 思考强度：`-c model_reasoning_effort="medium"`（可选：`low` / `medium` / `high` / `xhigh`）

### 常用命令模板

**只读探测 / 问答（无副作用）**

```bash
codex exec --ephemeral -s read-only -m gpt-6.2-sol -c model_reasoning_effort="medium" "<PROMPT>"
```

**修改工作区代码**

```bash
codex exec -s workspace-write -m gpt-6.2-sol -c model_reasoning_effort="medium" "<PROMPT>"
```

**独立 Git Worktree 隔离执行（推荐用于并行工单）**

```bash
codex exec --worktree -s workspace-write -m gpt-6.2-sol -c model_reasoning_effort="medium" "<PROMPT>"
```

### 常用选项速查

| 参数 | 作用 |
| --- | --- |
| `-m, --model <MODEL>` | 指定模型（如 `gpt-6.2-sol`） |
| `-c, --config <key=value>` | 覆盖 `~/.codex/config.toml` 配置（如 `model_reasoning_effort="medium"`） |
| `-p, --profile <NAME>` | 叠加 `$CODEX_HOME/<name>.config.toml` 配置 |
| `-s, --sandbox <MODE>` | 沙箱策略：`read-only` / `workspace-write` / `danger-full-access` |
| `--worktree` | 在新托管 Git worktree 中运行 |
| `-C, --cd <DIR>` | 指定工作根目录 |
| `--ephemeral` | 不落盘持久化会话文件 |
| `--json` / `-o <FILE>` | 输出 JSONL 事件流 / 将最后一条回复写入文件 |

### 注意事项

- 调用模型 API 与读取 `~/.codex` 凭证需要联网与本地配置访问权限（在沙箱环境下运行需放行）。
- 启动时可能提示 `~/.codex/config.toml` 中 `mcp_servers.playwright.type` 被忽略，属无害告警，不影响执行。

---

## 2. Claude Code CLI

- **二进制路径**：`/home/wangjian/.local/bin/claude`（指向 `/home/wangjian/.local/share/claude/versions/2.1.332`）
- **实测默认模型**：`ezios/deepseek-v4.1-flash[1m]`（1M 上下文，**无需显式传 `--model`**）
- **默认约定配置**：
  - 思考强度：`--effort max`（可选：`low` / `medium` / `high` / `xhigh` / `max`）

### 常用命令模板

**只读探测 / 纯文本问答（禁用工具，无副作用）**

```bash
/home/wangjian/.local/bin/claude -p --effort max --no-session-persistence --output-format json --tools "" -- "<PROMPT>"
```

**修改工作区代码（非交互自动编辑；注意避免依赖需人工确认的 Bash 命令，或由主控在外部统一跑验证）**

```bash
/home/wangjian/.local/bin/claude -p --effort max --permission-mode auto --no-session-persistence < prompt.md
```

**独立 Git Worktree 隔离执行（推荐用于并行工单）**

```bash
/home/wangjian/.local/bin/claude -p --effort max --permission-mode auto -w <worktree-name> -- "<PROMPT>"
```

### 常用选项速查

| 参数 | 作用 |
| --- | --- |
| `-p, --print` | 非交互模式，输出结果后退出 |
| `--effort <LEVEL>` | 思考强度：`low` / `medium` / `high` / `xhigh` / `max` |
| `--model <MODEL>` | 指定模型（使用默认接入模型时可省略） |
| `--permission-mode <MODE>` | 权限模式：`acceptEdits` / `auto` / `dontAsk` / `plan` / `manual` / `bypassPermissions` |
| `-w, --worktree [name]` | 为本次会话创建独立 Git worktree |
| `--output-format <FMT>` | 输出格式：`text` / `json` / `stream-json`（仅 `-p`） |
| `--no-session-persistence` | 不保存会话记录到磁盘（仅 `-p`） |
| `--tools <tools...>` | 限定内置工具集；传 `""` 表示禁用全部工具 |

### 注意事项

- **参数分隔符 `--`**：`--tools`、`--allowed-tools` 等属于变长参数，后面必须加 `--` 再跟 prompt，否则 prompt 会被解析为前一个选项的值。
- **自定义模型告警**：stderr 中出现 `[claude-code:unrecognized_model] {"model":"ezios/deepseek-v4.1-flash[1m]"}` 为正常提示，不阻断执行；`--effort max` 兼容无报错，实际思考 token 分配取决于上游网关透传实现。
- **沙箱权限**：由于软链指向 `~/.local/share/claude` 且需访问外部网关，在沙箱环境下运行需放行权限。
