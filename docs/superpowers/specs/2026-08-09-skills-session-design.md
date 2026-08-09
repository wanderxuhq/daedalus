# Daedalus Skills + 会话架构设计

日期：2026-08-09
状态：已批准（brainstorming）

## 1. 背景与目标

Daedalus 是一个终端 Agent（类似 Claude Code），核心为零运行时依赖（`ai/`、`tools/`、`config/`、`agent/`），外加一个薄 CLI（`cli/`）。本设计新增两件事：

1. **Skills** —— Markdown 指令包（遵循 Claude Code / Agent Skills 格式），Agent 可按需加载以指导行为。
2. **持久会话** —— 跨输入的会话状态。Skill 依赖它（已加载的 skill 内容必须跨 REPL 输入存续），提示词缓存优化也依赖它。

### 非目标（本子项目范围外）

- **MCP 支持** —— 独立子项目，本设计落地之后再单独设计。
- **Web 面板** —— 未来 UI；本设计只确保核心与 UI 无关，将来可无耦合地构建 web 面板。

### 约束

- **不得引入任何直接或间接依赖 node-gyp 的依赖**（用户强约束）。任何 `npm install` 必须先经用户确认。本设计需要**零新增运行时依赖**。
- **提示词缓存最大化**：system prompt 前缀必须保持稳定；可变内容（skill 正文、工具结果）进入对话消息，绝不进入 system prompt。
- **核心不得依赖 CLI/UI**。CLI 只是核心的一个消费者；web 面板必须能不修改直接 import 同一套核心。

## 2. 架构

### 2.1 分层

```
┌─ src/core/ ──────────────────── 与 UI 无关的核心（库）
│   ├─ engine.ts         ← DaedalusEngine：单一门面，持有全部
│   ├─ session.ts        ← Session：MessageHistory + 已加载 skill 状态
│   ├─ system-prompt.ts  ← system prompt 组装（核心内）
│   └─ skills/           ← SkillRegistry：加载/匹配/渲染
│
├─ src/ai/ · src/tools/ · src/config/  ← 现有，基本不动
│
└─ src/cli/ ─────────────── 一个消费者：new Engine() + subscribe()
```

- 核心不 import `src/cli/` 中的任何东西。CLI 只 import 核心。
- `src/index.ts` 成为核心库的公共 API 面（已存在）。

### 2.2 DaedalusEngine（门面）

`DaedalusEngine` 是唯一入口。它持有：

- `Session`（会话状态）
- `SkillRegistry`（已加载 skill 的元数据 + 正文）
- 工具注册表（现有 `tools/registry.ts` 的输出）
- AI client 和配置

```ts
interface EngineOptions {
  client: AiClient;
  cwd: string;
  askPermission: (action: string, target: string) => Promise<boolean>;
  skillDirs?: string[];       // 额外 skill 搜索目录（默认：.claude/skills + ~/.daedalus/skills）
  maxIterations?: number;
}

class DaedalusEngine {
  constructor(opts: EngineOptions);
  subscribe(handler: (ev: CoreEvent) => void): () => void;  // 返回取消订阅函数
  run(prompt: string): Promise<string>;                      // 驱动一次用户输入走完 agent 循环
  get skills(): SkillInfo[];                                 // 供 UI 列出（名字 + 描述）
  loadSkill(name: string): Promise<SkillInfo>;               // 显式加载（如 /skill-name）
  dispose(): void;
}
```

`engine.run()` 是 CLI 处理用户 prompt 的唯一路径。agent 循环在内部运行，跨调用共享 Session 的 history。

### 2.3 Session（生命周期）

`Session` 是持久会话状态。它持有：

- `MessageHistory`（现有 `agent/context.ts`，提升到核心层）—— messages 数组
- `loadedSkills: Map<string, SkillInfo>` —— 本会话已加载了哪些 skill

`Session` 的生命周期与 `DaedalusEngine` 相同（进程/REPL 会话期间）。每次 `engine.run(prompt)` 把用户 prompt 追加进 history，运行 agent 循环（可能追加 assistant 消息和工具结果），返回最终文本。

生命周期事件（`session_start`、`session_end`）标记 Session 的边界，UI 据此渲染「会话开始」/ 重置状态。

### 2.4 Skills

#### 格式

一个 skill 是包含 `SKILL.md` 的目录：

```
--- (YAML frontmatter)
name: code-review
description: Review code changes for correctness, security, and style.
when_to_use: When the user asks to review code or check a diff.
allowed-tools: []        # 可选：限制该 skill 可用的工具
disallowed-tools: []     # 可选：禁用特定工具
disable-model-invocation: true   # 可选：仅限用户触发
user-invocable: true             # 默认 true
---
markdown 正文...
```

frontmatter 必填：`name`、`description`。缺失/损坏的 frontmatter：skill 仍以空元数据加载（`/skill-name` 仍可用），与 Claude Code 行为一致。

#### 发现（优先级）

1. 项目：起始目录及其父目录直到仓库根的 `.claude/skills/`
2. 用户：`~/.daedalus/skills/`
3. 通过 engine 选项 `skillDirs` 指定的额外目录

同名冲突时优先级高者胜出。插件/命名空间 skill 超出范围（目前没有插件系统）。

#### 模型可见面：单一 `Skill` tool

工具列表中只新增一个 tool：`Skill`。

- name：`Skill`
- description：「按名字加载一个 skill。Skill 提供指导对话的指令/上下文。可用 skills：<name — desc>（每个已加载的 skill 一条）」
- input schema：`{ name: string }`

会话开始时，只有 skill **清单**（name + description，受上下文预算约束）——放在 `Skill` tool 的 description 里。全文按需加载。

#### 调用契约

模型调用 `Skill(name="code-review")` 时：

1. 在 registry 中校验；若未知，返回错误 tool_result。
2. 渲染正文：应用 `$ARGUMENTS` 替换（v1 为空——v1 不传参）和 `` `!command`` `` 动态上下文（推迟到 v1.1；v1 正文为静态）。
3. 返回**单个 tool_result**，内容为渲染后的 SKILL.md 正文（role `user`，与 assistant `tool_call` 配对）。
4. 在 Session 中标记该 skill 已加载（`loadedSkills`）。
5. 若已加载且内容相同，返回简短「已加载」提示而非重复注入（去重）。

全文由 tool_result 承载，在整个会话期间保留在 history 中——这就是「以单条消息进入对话」的行为，且缓存安全（位于 system-prompt 缓存断点之下的对话层）。

#### 工具过滤（allowed-tools / disallowed-tools）

v1 不实现。v1 的 skill 是纯指令型。frontmatter 字段会被解析但忽略，并在 skill 清单渲染中加注说明。动态工具注册/过滤推迟到 MCP 子项目——那才是它的归属。

#### 用户触发

- REPL 里输入 `/skill-name` → `engine.loadSkill(name)` → 标记已加载 + 把正文作为 user message 注入 history（内容路径与 `Skill` tool 相同，但由用户发起，而非模型）。
- `/skills` 列出用户可触发的 skills（name + description + user-invocable 标志）。

## 3. 事件流

### 3.1 核心事件类型

```ts
type CoreEvent =
  | { type: 'session_start' }
  | { type: 'session_end' }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; inputDelta: string }
  | { type: 'skill_load'; name: string }         // 新增：skill 已加载（状态变化）
  | { type: 'done'; message: Message }
  | { type: 'error'; error: AiError };
```

现有 `StreamEvent` 类型（`ai/types.ts`）复用/扩展。`skill_load` 是给 UI 的状态事件；它**不进 messages**。skill 正文本身通过 `Skill` tool 的 tool_result 进入 messages。

### 3.2 数据流

```
用户 prompt
  → engine.run(prompt)
      → Session 将 user message 追加进 history
      → agent 循环：streamChat(messages, tools=[内置..., Skill], cache)
          → 发出 StreamEvent → 作为 CoreEvent 转发给订阅者
          → 遇到 Skill tool_call → skill 加载 → tool_result 承载正文
          → 下一轮迭代时正文已在上下文中
      → 返回最终文本
```

## 4. 提示词缓存

- **稳定前缀**：system prompt（核心组装、恒定）+ 会话早期消息。skill 内容绝不进入 system prompt。
- **Skill 正文**是对话 user message（经 tool_result），位于缓存断点之下——加载 skill 不会使前缀缓存失效。
- `cache: { enabled: true }` 在 `streamChat` 上保持现状。
- MCP 延迟加载优化超出范围（属于 MCP 子项目）。

## 5. 错误处理

- `Skill` tool 调用中遇到未知 skill 名 → 错误 tool_result（`Unknown skill: X`，`isError: true`），循环继续（模型可重试或放弃）。
- frontmatter 损坏 → skill 以空元数据加载；`/skill-name` 仍可用。
- skill 目录不可读 → 在 registry 加载时跳过，记录警告。
- `engine.run` 的错误向上传播给调用方（CLI 捕获并渲染）；同时为 UI 发出 `error` CoreEvent。

## 6. 测试

- **SkillRegistry**：发现优先级、frontmatter 解析（有效/损坏/缺失）、清单渲染、未知名处理。
- **Skill tool 契约**：模型 `Skill(name)` 调用 → tool_result 承载正文；重复调用去重；未知名 → 错误结果。
- **Session**：跨 `run` 持久化（messages 累积、已加载 skill 保持）、生命周期事件顺序。
- **Engine**：门面正确接线 client/tools/skills/session；用 fake AiClient 端到端跑 `run`；`subscribe` 按序收到事件。
- **CLI**：`/skill-name` 和 `/skills` 命令路由（单元级，不跑完整 REPL 循环）。
- **缓存**：断言发送给 adapter 的 messages 数组在非加载轮次间保持稳定（仅追加 assistant/user 消息时前缀不变）。
- 现有测试保持通过（45/45）。

## 7. 范围检查 / 推迟到 MCP 子项目

- MCP 传输、`mcp__server__tool` 命名、延迟工具搜索、schema 拍平、鉴权 —— 推迟。
- 动态工具注册/过滤（`allowed-tools`、按 skill 的工具集）—— 推迟。
- `context: fork`（子 agent）、`$ARGUMENTS` 传参、`` `!command`` `` 动态上下文 —— 推迟到 v1.1。
- 插件 skill、命名空间、`skillOverrides` —— 推迟（目前无插件系统）。
