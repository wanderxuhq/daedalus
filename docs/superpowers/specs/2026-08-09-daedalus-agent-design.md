# Daedalus — Agent CLI 设计文档

日期：2026-08-09
状态：草案（配置部分待后续讨论细化）

## 1. 概述

Daedalus 是一个类 Claude Code 的终端 Agent 项目。目标：Claude Code 能做的功能尽量做到。第一步采用**纵向切片**方式构建：AI 接入层 + 最小 Agent 循环，端到端跑通。

**核心原则：**

- 兼容不同 AI API 格式，首先实现 OpenAI 与 Anthropic 两种格式。
- 在接入 AI 的这一层之上再加一层（AI 接入层），Daedalus 调用 AI 服务时只经过这一层，**不直接调用** OpenAI / Anthropic 格式的 API。
- 不引入 langchain / langgraph。原因：langchain 的自研 IR 层职责重叠；langgraph 为复杂有状态编排设计，Agent 循环用 `while` 即可表达；两者依赖树深、审计成本高、违背"绝不碰 node-gyp"约束；YAGNI。边界：多 agent 协作、断点恢复等复杂编排出现时再评估（见 Roadmap）。
- 零运行时 AI 依赖（手写 HTTP + fetch + SSE 解析）。

## 2. 范围（第一步）

### 包含

1. AI 接入层：统一 IR 类型 + AiClient 接口 + OpenAI / Anthropic Adapter + SSE 解析 + HTTP helper + 统一错误模型。
2. Agent 循环：调 AI → 执行工具 → 循环，直至无工具调用或达迭代上限。
3. 工具系统：Bash、Read、Write/Edit、LS、Grep、Glob 六件套 + 权限雏形。
4. CLI：简易 REPL + ANSI 彩色渲染，支持 `npx` 调用。
5. 配置：环境变量 + 配置文件（细节待讨论，见 §8）。
6. 测试：node:test 全覆盖核心层。

### 不包含（进 Roadmap，见 §9）

丰富 TUI、完整权限系统、上下文压缩/历史裁剪/断点恢复、子代理与多 agent 协作、WebFetch/WebSearch 工具、更多 provider adapter、打包发布打磨。

## 3. 技术栈与工程约束

| 项 | 决策 |
|---|---|
| 语言 | TypeScript |
| 开发运行 | Node 24 原生 type-stripping 直接跑 `.ts`（不使用 enum/namespace/参数属性，import 带 `.ts` 扩展名） |
| 发布 | `tsc` 编译到 `dist/`，`package.json` 配 `bin` 支持 `npx` 调用 |
| 依赖 | 极简；**安装依赖前与用户确认；绝不引入直接或间接依赖 node-gyp 的包** |
| 测试 | `node:test`（零依赖） |
| 底层 AI 调用 | 原生 `fetch` + 手写 SSE 解析，不引入任何 AI SDK |

运行时预期仅有的依赖类型：无（全部用 Node 内置 + 原生 fetch）。构建期：`typescript`。

## 4. 目录结构

```
daedalus/
├── src/
│   ├── ai/                    # AI 接入层
│   │   ├── types.ts           #   统一 IR 类型 + AiClient 接口 + 流式事件
│   │   ├── errors.ts          #   统一 AiError（auth/rateLimit/timeout/network/parse…）
│   │   ├── http.ts            #   共享 HTTP helper：baseURL、headers、超时、重试
│   │   ├── sse.ts             #   SSE 流解析器（ReadableStream → 事件）
│   │   ├── index.ts           #   createAiClient(config) 工厂
│   │   └── providers/
│   │       ├── anthropic.ts   #   Anthropic Adapter（格式 ↔ IR）
│   │       └── openai.ts      #   OpenAI Adapter（格式 ↔ IR）
│   ├── agent/
│   │   ├── loop.ts            #   主循环
│   │   └── context.ts         #   消息历史管理
│   ├── tools/
│   │   ├── types.ts           #   Tool 接口 + ToolContext
│   │   ├── registry.ts        #   注册表
│   │   ├── permission.ts      #   权限雏形（allow/deny/ask）
│   │   ├── bash.ts / read.ts / write.ts / edit.ts / ls.ts / grep.ts / glob.ts
│   ├── cli/
│   │   ├── main.ts            #   bin 入口（解析 argv）
│   │   ├── repl.ts            #   REPL 输入循环
│   │   └── render.ts          #   ANSI 彩色渲染
│   ├── config/
│   │   └── config.ts          #   配置加载（默认值 → 配置文件 → 环境变量）
│   └── index.ts
├── tests/                     # node:test 测试
├── tsconfig.json
└── package.json               # bin: { "daedalus": "dist/cli/main.js" }
```

## 5. AI 接入层

### 5.1 统一 IR 类型（`ai/types.ts`）

Daedalus 全程只和这套类型打交道，不接触任何 provider 格式。

一条消息 = role + 内容块数组，可无损表达 OpenAI 与 Anthropic 两种格式：

```ts
type ContentBlock =
  | { type: 'text'; text: string }                          // 文本
  | { type: 'thinking'; thinking: string }                  // 思考块（anthropic 特有，预留）
  | { type: 'tool_call'; id: string; name: string; input: unknown }   // 工具调用
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean };

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: ContentBlock[];
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;   // JSON Schema
}

interface ChatParams {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

// 流式事件 —— agent 循环和 CLI 只消费这个
type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; inputDelta: string }  // JSON 参数增量
  | { type: 'done'; message: Message }                            // 完整 assistant 消息
  | { type: 'error'; error: AiError };

interface AiClient {
  streamChat(params: ChatParams): AsyncIterable<StreamEvent>;
}
```

### 5.4 缓存支持（prompt caching）

目标：**最大化命中 AI 提供商的 prompt 缓存**，降低多轮对话成本。

两种缓存机制：

- **Anthropic prompt caching**：显式标记，`cache_control: { type: "ephemeral" }` 打在稳定上下文段上，命中靠**前缀匹配**（5 分钟内有效，命中段降价）。
- **OpenAI**：自动 prompt caching，无需显式标记，命中靠**稳定前缀**（前缀 ≥1024 token 且逐字匹配）。

**尽量命中缓存的工程原则（调度/调用侧）：**

1. **前缀稳定**：请求体顺序固定为 `system → 工具定义 → 历史消息 → 本轮新增`，任何段不重排、不混入动态内容。工具定义与 system prompt 在会话内生成后**复用**（缓存起来），保证逐字一致。
2. **显式标记**：Anthropic adapter 在稳定段打 `cache_control`：system 字段、工具定义、历史消息的缓存断点（首个 system 之后、以及历史消息的分段处）。
3. **增量追加**：每轮只把新增的 user/assistant 消息追加在末尾，前缀保持逐字不变。
4. **裁剪与缓存的关系**（未来做裁剪时）：优先从末尾裁剪、保留前缀；裁剪策略必须与缓存意识结合，避免频繁破坏前缀。

`ChatParams` 增加缓存开关：`cache?: { enabled: boolean }`，默认启用。

### 5.2 Adapter 双向转换

每个 provider 一个 adapter，负责两件事，其余皆哑：

| 方向 | 转换 |
|---|---|
| IR → 请求体 | `ChatParams`（IR 消息 + 工具定义）→ provider 格式的 JSON body |
| 响应体 → IR | provider 的 SSE 流 → `AsyncIterable<StreamEvent>` |

映射规则：

- `system` 消息：Anthropic 抽到顶层 `system` 字段；OpenAI 放 `role: "system"` 消息。
- 工具调用/结果：Anthropic `tool_use` / `tool_result` ↔ IR `tool_call` / `tool_result`；OpenAI `tool_calls[].function` ↔ IR `tool_call`。
- `tool_result` 在 IR 中作为消息块，转 OpenAI 时映射为 `role: "tool"` 消息，`tool_call_id` 关联。

### 5.3 SSE 与错误处理

- `sse.ts`：共享 SSE 行解析器（`data:` 事件行），处理分块、断行、多事件、CRLF、空行。OpenAI 与 Anthropic 的 `data:` 事件体结构不同，由各自 adapter 解释。
- 统一 `AiError`（带 `kind` 判别字段）：`auth`（401/403）、`rateLimit`（429）、`server`（5xx）、`badRequest`（4xx）、`timeout`、`network`、`parse`。
- 重试：429 / 5xx 指数退避，默认 3 次，可配置；支持 `AbortSignal` 取消。
- 取消：Agent 循环在达到迭代上限或用户中断时中止流。

## 6. Agent 循环（`agent/loop.ts`）

```
while true:
  1. 把完整消息历史（含工具结果）发给 AI → 消费流式事件
  2. 流式渲染给 CLI，同时累积完整 assistant 消息
  3. 检查 assistant 消息中的 tool_call 块：
     - 有 → 逐个执行 → 将 tool_result 追加进历史 → 回到步骤 1
     - 无 → 结束循环
  4. 安全阀：最多 N 轮迭代（默认 100），防无限循环
```

要点：

- 历史保留全部消息，第一步不裁剪；上下文压缩/裁剪进 Roadmap。
- **历史按不可变顺序累积**（`system → 工具定义 → 历史 → 本轮新增`），新增只追加末尾、前缀永不重排——配合 §5.4 缓存最大化命中。
- 工具结果以 `tool_result` 块追加到 assistant 消息后（anthropic 风格）；对 OpenAI 由 adapter 转为 `tool` role。
- 每轮执行工具前过权限判定。
- 流式事件从 AI 层透出，CLI 直接消费实时显示。

## 7. 工具系统

### 7.1 工具接口

```ts
interface Tool {
  name: string;
  description: string;
  inputSchema: unknown;   // JSON Schema，用于参数校验 + 传给 AI
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

interface ToolContext {
  cwd: string;
  allowlist: PermissionRule[];
  askPermission: (action: string, target: string) => Promise<boolean>;
}
```

### 7.2 六件套实现要点

| 工具 | 要点 |
|---|---|
| **bash** | `child_process.spawn`（非 exec，避免 shell 注入歧义 + 支持长输出）；cwd 默认项目目录；超时默认 2 分钟；**bash 一律先询问**（第一步保守） |
| **read** | `fs.readFile`；可选行号；超大文件拒绝并提示分段读 |
| **write** | 写前若文件已存在必须确认（覆盖保护）；自动创建父目录 |
| **edit** | 精确字符串替换；目标不存在或匹配不唯一则报错（不做模糊匹配） |
| **ls** | 列目录；默认忽略 `node_modules` / `.git` |
| **grep** | 递归搜索；忽略 `node_modules` / `.git` |
| **glob** | 自研最小 glob 匹配（`*`/`**`/`?`）；不引入 glob 库 |

### 7.3 权限雏形

- 权限询问在终端进行：`是否允许 bash 执行: <命令>? [y/n]`
- 规则源：`~/.daedalus/config.json` 中的 allowlist / denylist；后续可做 per-project `.daedalus/settings.json`
- 三类判定：`allow`（执行）/ `deny`（拒绝）/ `ask`（询问）
- 每个工具执行前经 `shouldAllow(rule, target)` 判定

### 7.4 错误处理

- 工具抛错 → 转为 `tool_result { isError: true }` 返回给 AI，让 AI 自行纠正，而非崩溃循环。
- bash 非零退出码 → 作为 `isError` 结果（附 stdout/stderr）。
- AI 层报错（认证/超时/限流）→ 询问用户是否重试。

## 8. 配置（待后续讨论细化）

> 本节为当前理解，配置细节将在后续单独讨论后补充定稿。

- 加载顺序（后者覆盖前者）：默认值 → `~/.daedalus/config.json`（可选）→ 环境变量（`DAEDALUS_*`）。
- 关键字段：默认 provider、每个 provider 的 apiKey 来源（环境变量）+ baseURL（可覆盖，以兼容 Ollama/DeepSeek/vLLM 等 openai 兼容服务）、默认 model。
- 新增 provider 不需要改代码：`createAiClient` 按 provider 名查适配器，baseURL 可覆盖。
- 模型默认跟随 provider（openai→`gpt-4o`，anthropic→`claude-sonnet-4-5`），可覆盖。
- 权限规则：bash 的 allow/deny/default 配置。

## 9. Roadmap

- [ ] 配置完整定稿（待讨论）
- [ ] 丰富 TUI（多面板）
- [ ] 权限系统完整化（per-project settings、细粒度规则）
- [ ] 上下文压缩 / 历史裁剪（优先从末尾裁剪、保留前缀，与 §5.4 缓存策略结合）/ 会话断点恢复
- [ ] 子代理（subagents）与多 agent 协作 → 届时评估 langgraph
- [ ] 更多工具：WebFetch / WebSearch、交互式提问、文件编辑改进
- [ ] 更多 provider adapter（Azure、Google…）
- [ ] npx 打包发布打磨

## 10. 测试计划（node:test）

| 层 | 测试内容 |
|---|---|
| **sse** | 分块喂入、断行、多事件、CRLF、空行（fixture 流） |
| **providers** | IR→请求体、响应体→IR 的**双向转换**测试；openai/anthropic 各一套 fixture；真实格式样例断言；**缓存标记**：anthropic 转换结果含正确 `cache_control` 断点、openai 请求体保持稳定前缀 |
| **http** | mock fetch：认证错误→AiError、429/5xx→重试、超时→AiError |
| **tools** | bash 跑 `echo`；read/write/edit 正常与覆盖保护；grep/ls/glob 行为 |
| **agent loop** | mock AI 客户端：一轮工具调用→正确执行→结果回传；无工具调用→直接结束；达到迭代上限→安全退出 |

## 11. 成功标准

1. `npx daedalus`（或本地 `node` 运行）可启动 REPL，与 OpenAI 或 Anthropic 模型对话。
2. 对模型发出"读当前目录 / 创建文件 / 跑一个命令"等指令，Agent 能自主调用工具完成并返回结果。
3. AI 接入层与 provider 格式完全解耦：切换 provider 只改配置，不改 daedalus 代码。
4. 全部测试通过；运行时无第三方依赖（除 Node 内置）。
