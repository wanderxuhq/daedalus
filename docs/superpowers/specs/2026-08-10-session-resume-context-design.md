# Daedalus 会话断点恢复 + 上下文裁剪设计

日期：2026-08-10
状态：待评审

## 1. 背景与目标

Daedalus 目前在一次进程内持有会话状态（`Session` 的消息历史 + 已加载 skill 集合），退出即丢失；并且消息历史无上限增长，长会话会把整个上下文（含工具结果、skill 正文）全部发给模型，超过窗口后失败或成本飙升。对应 spec §9 Roadmap 两项：

1. **会话断点恢复** —— 把会话持久化到磁盘，进程重启后可恢复现场继续对话。
2. **上下文压缩 / 历史裁剪** —— 给消息历史设定 token 预算，超限时优先从最旧处裁剪、保留前缀，并与 §5.2 提示词缓存策略结合（避免频繁破坏缓存前缀）。

### 非目标（本子项目范围外）

- **模型驱动的摘要压缩**（把被裁剪区域摘要成一段文字，需额外一次模型调用）—— 记入 Roadmap 后续；本设计只做确定性裁剪，但预留裁剪接口使摘要可后续插入。
- **REPL 内的 `/sessions` 列表与 `/resume` 切换** —— 记入后续；本设计只提供启动期 `--resume` 与自动保存。
- **真正的 tokenizer** —— 零依赖约束下用字符估算（详见 §4.2），不引入任何分词依赖。

### 约束（沿用全局）

- **不得引入任何直接或间接依赖 node-gyp 的依赖**；任何 `npm install` 必须先经用户确认。本设计**零新增运行时依赖**。
- **提示词缓存最大化**：system prompt 前缀必须稳定；裁剪必须"稀触发、大步进"，避免每轮都改前缀。`cache: { enabled: true }` 保持开启。
- **核心不得依赖 CLI/UI**。`SessionStore`、裁剪逻辑放核心；CLI 只是消费者。
- TypeScript 约定：`erasableSyntaxOnly`（无 enum/namespace/ctor 参数属性）、显式 `.ts` 扩展名、`target: ES2022`（无 `findLast`/`toSorted` 等 ES2023+）。
- 测试：`node --test 'tests/**/*.test.ts'`。现有 98 个测试必须保持通过。

## 2. 架构

```
┌─ src/core/ ─────────────────────────────── 核心（库，不依赖 CLI）
│   ├─ session.ts          ← Session：消息历史 + 已加载 skill 状态
│   ├─ session-store.ts    ← 新增：磁盘持久化（保存/列出/加载/原子写）
│   ├─ engine.ts           ← DaedalusEngine：门面，持有 store/初始状态/预算
│   └─ events.ts           ← CoreEvent 新增 context_trim
│
├─ src/agent/ ────────────────────────────── agent 循环（核心的一部分）
│   ├─ loop.ts             ← runAgent：每轮迭代前调用 trimHistory
│   └─ context.ts          ← 新增：token 估算 + 裁剪纯函数（turn 边界感知）
│
└─ src/cli/ ──────────────────────────────── 一个消费者
    ├─ main.ts             ← --resume [id] 标志；构造 store；接入初始状态
    └─ render.ts           ← 渲染 context_trim 事件（dim 提示）
```

- 核心不 import `src/cli/`；`src/agent/context.ts`、`src/core/session-store.ts` 都是纯核心模块。
- 裁剪与保存都挂在核心侧，任何未来 UI（web 面板等）都能复用同一套。

## 3. 会话持久化与断点恢复

### 3.1 `SessionStore`（新增 `src/core/session-store.ts`）

文件型存储，一个会话一个 JSON 文件。

- **目录**：默认 `join(homedir(), '.daedalus', 'sessions')`；`DAEDALUS_SESSIONS_DIR` 环境变量可覆盖（与 `DAEDALUS_CONFIG_PATH` 的覆盖思路一致）。
- **文件名**：`<id>.json`，`id` 为本地时间戳 slug，如 `2026-08-09T23-15-07`（可排序、唯一）。
- **文件内容**：`{ id, createdAt, updatedAt, cwd, messages, loadedSkills }`。
  - `messages` 是 `Message[]`。`ContentBlock` 全为普通 JSON 数据（`tool_call.input` 来自 `JSON.parse`、`tool_result.content` 是字符串），`JSON.stringify`/`parse` 无损往返，无需自定义序列化。
- **API**：
  ```ts
  class SessionStore {
    constructor(dir?: string);                       // 默认 ~/.daedalus/sessions
    save(state: SessionState, meta?: { id?: string; cwd?: string }): Promise<string>;  // 生成/复用 id，原子写
    load(id: string): Promise<SessionState & { id: string; createdAt: string; updatedAt: string; cwd?: string }>;
    list(): Promise<SessionMeta[]>;                  // { id, updatedAt, messageCount }（不读全文）
    latest(): Promise<SessionMeta | null>;           // 按 updatedAt 取最新
    remove(id: string): Promise<void>;
  }
  ```
- **原子写**：先写 `<id>.json.tmp` 再 `rename`，避免中途崩溃产生损坏文件；`load` 遇损坏 JSON 抛 `AiError`-风格错误（或空对象 + 明确失败），不静默吞掉。`save` 读既有文件仅用于保留 `createdAt`：文件不存在（ENOENT）视为新会话（`createdAt = now`）；文件存在但 JSON 损坏则抛 "Corrupt session file" 错误，不静默覆盖（与 load 的姿势一致）。
- **`SessionState`**：`{ messages: Message[]; loadedSkills: string[] }`（定义见 §3.2）。`cwd` 只作文件元数据记录，恢复时不改当前工作目录（CLI 从哪启动就留在哪）。

### 3.2 `Session` 改造

新增三个方法：

```ts
class Session {
  getState(): SessionState;              // 深拷贝 messages + skills，避免外部改内部数组
  replaceMessages(msgs: Message[]): void;  // 裁剪/恢复用：整体替换消息数组
  restoreLoadedSkills(names: string[]): void; // 恢复期用：只置集合，不发 skill_load 事件
}
```

- `getMessages()` 目前返回内部数组引用（旧评审已记录为 deferred minor）；裁剪走 `replaceMessages` 显式替换，不依赖引用泄漏。
- **skill 正文保护不靠对象引用**：skill 正文有两条注入路径——引擎 `loadSkill()` 直接 `addMessage`，以及 **Skill 工具路径**（模型在 run 中调用 `Skill` 工具，正文由 `loop.ts` 泛化构造 `tool_result`，消息对象不被任何调用方持有）。两者都按 `[Skill: <name>]\n\n<body>` 统一内容标记（§4.3），裁剪以**内容谓词**识别，而非消息对象引用。
- **恢复时系统消息**：持久化状态里的 `messages[0]` 就是原会话的 system 消息。恢复时**逐字复用**（不重新 `buildSystemPrompt()`），保证缓存前缀稳定——即便代码版本升级导致 prompt 文案变化，也不在会话中途静默改变前缀。

### 3.3 `DaedalusEngine` 改造

```ts
interface EngineOptions {
  // …现有字段…
  initialState?: SessionState;     // 传入则从该状态播种会话（跳过新建 system 消息）
  sessionId?: string;              // 已有会话 id（resume 时复用，后续保存写同一文件）；缺省时首次 save() 生成
  sessionStore?: SessionStore;     // 传入则每次 run() 完成后自动保存
  maxContextTokens?: number;       // 历史预算，默认 100_000（估算 token，见 §4.2）
}

class DaedalusEngine {
  constructor(opts: EngineOptions);
  getSessionState(): SessionState;             // 供外部手动保存
  // run() 在 runAgent 完成后自动调用 store.save(getSessionState())
  // dispose() 先保存再发 session_end
}
```

- **`initialState` 播种**：`new Session()` → 若 `initialState` 存在：`replaceMessages(state.messages)` + `restoreLoadedSkills(state.loadedSkills)`；否则按现状注入 `buildSystemPrompt()`。防御：若恢复出的 messages 里没有 system 消息（旧格式/损坏），则补一条全新的 system 消息。
- **自动保存**：`run()` 结束后（仅正常完成）保存。崩溃最多丢失一轮进行中的 turn，已完成 turn 不丢。恢复后 skill 正文以内容标记存在 messages 里，`loadedSkills` 集合随状态恢复，二者一致（§4.3）。
- **稳定会话 id**：引擎持有 `sessionId`，每次保存复用（`save(state, { id: this.sessionId, cwd })`），首次保存用返回值回填。一个会话对应一个 `<id>.json` 文件，跨 run/dispose/resume 不碎片化（§3.1"复用 id"）。
- **失败 turn 回滚**：`runAgent` 在追加 prompt 前记录历史长度；本轮抛错（client error / 流无终结事件）时把历史截回该长度再抛出，避免失败 turn 的孤立 prompt/工具消息在下次成功 `run()` 时被持久化（恢复后模型看到从未完成的 turn）。

### 3.4 CLI

- `main.ts` 解析 `--resume [id]`：有 `--resume` 则 `store.latest()` 或 `store.load(id)`，把结果作为 `initialState` 传入引擎；构造 `SessionStore` 并传给引擎以启用自动保存。
- 用法示例：`daedalus --resume`（最近一次）、`daedalus --resume 2026-08-09T23-15-07`（指定会话）。
- REPL 内 `/sessions`、`/resume <id>` 记入后续（见 §8），本设计不扩 `EngineLike` 接口。

## 4. 上下文裁剪（cache 感知的历史裁剪）

### 4.1 设计原则：稀触发、大步进、turn 边界

- **稀触发**：只有估算 token 超预算才裁剪；不超预算则消息原样追加，前缀逐字不变 → 缓存持续命中。
- **大步进**：一旦触发，裁到预算的 **50%**（`target = maxTokens / 2`），留足后续追加空间，避免下一轮又触发、前缀频繁变化（§5.2.4 的"避免频繁破坏前缀"）。
- **turn 边界**：一次裁剪只能丢弃**完整 turn**，绝不能把 assistant 的 `tool_call` 与其后续 `tool_result`（同属一个用户消息）拆散。turn 定义为"用户 prompt 消息 + 其后所有消息，直到下一个用户 prompt 消息之前"。判定 prompt 消息：`role === 'user'` 且 content **不全部是** `tool_result` 块。
- **保留前缀**：system 消息永远不裁。从最旧处开始丢整 turn，**保留最近的 turn**（当前任务上下文）。

### 4.2 token 估算（`src/agent/context.ts` 纯函数）

零依赖下的启发式估算，按字符粗估：

```ts
export function estimateTokens(messages: Message[]): number {
  let n = 0;
  for (const m of messages) {
    n += 4; // 每条消息固定开销
    for (const b of m.content) {
      const text = b.type === 'text' ? b.text
        : b.type === 'thinking' ? b.thinking
        : b.type === 'tool_result' ? b.content
        : b.type === 'tool_call' ? JSON.stringify(b.input) : '';
      n += Math.ceil(text.length / 4);
      n += 2; // 每块开销
    }
  }
  return n;
}
```

- 粗估偏保守即可：宁可早裁也不让上下文爆窗。文档注明是近似，不追求精确。
- 对超大 `tool_result`（bash 长输出）自然计入预算。

### 4.3 `trimHistory`（`src/agent/context.ts` 纯函数）

```ts
export interface TrimOptions {
  maxTokens: number;          // 预算
  estimate?: typeof estimateTokens;   // 可注入，便于测试
  isProtected?: (m: Message) => boolean; // 不可裁剪的判定；默认 skill 正文检查
}

export function trimHistory(messages: Message[], opts: TrimOptions): Message[];
```

算法：

1. 从最前找到第一个非 system 消息索引 `start`；`prefix = messages.slice(0, start)`。
2. `conversation = messages.slice(start)`；遍历其**用户 prompt 边界**（定义见 §4.1），得到每个 turn 的起始下标 `b[0] < b[1] < …`。
3. 从 `i = 0` 起：若 `estimateTokens([...prefix, ...conversation.slice(b[i])]) <= opts.maxTokens / 2` 或剩余不足 `MIN_KEEP_TURNS`（常量 2），则停；否则 `i++`。`maxTokens / 2` 即 §4.1 的"大步进"目标（裁到预算的 50%），保证裁剪后留足追加空间、不会下一轮又触发。
4. 返回 `[...prefix, ...conversation.slice(b[i])]`（即丢掉了前 `i` 个完整 turn）。
5. **保护谓词**：默认 `isProtected` 判定"该 user 消息含以 `[Skill: ` 开头的块（text 或 tool_result）"→ skill 正文消息。任何被判定保护的消息不丢——若它落在将被丢弃的 turn 里，则把裁剪点退回到该 turn 之前（该 turn 整体保留）。

返回值与入参相等（无需裁剪）时返回原引用（`===`），调用方据此判断是否触发 `context_trim` 事件。

**skill 正文为何用内容标记而非对象引用**：正文经两条路径进入历史——引擎 `loadSkill()` 直接注入，以及 **Skill 工具**（模型在 run 中调用）经 `loop.ts` 泛化构造 `tool_result` 消息。后者的消息对象由循环新建、不被任何调用方持有，`markSkillLoaded` 拿不到引用；而内容标记在两条路径上一致（`[Skill: name]\n\n<body>`），谓词匹配即可覆盖两者。裁剪点退回该 turn 起点，同时保住了触发加载的 `tool_call` 与返回正文的 `tool_result` 配对（§4.1 的 turn 边界不变量）。

**边界情况**：
- 最近一个 turn 本身就超预算 → 不裁（预算只是建议，绝不把唯一工作上下文裁空）；`MIN_KEEP_TURNS` 兜底。
- 没有 system 消息 / 没有用户 prompt → 安全返回。
- 保护优先于预算：若多轮加载了多个 skill，保留受保护 turn 后可能超出预算——可接受，一致性优先于精确预算。

### 4.4 事件与渲染

`CoreEvent` 新增：

```ts
| { type: 'context_trim'; dropped: number; kept: number }
```

`runAgent` 每轮迭代前：

```ts
const before = session.getMessages();
const trimmed = trimHistory(before, { maxTokens });
if (trimmed !== before) {
  session.replaceMessages(trimmed);
  session.bus.emit({ type: 'context_trim', dropped: before.length - trimmed.length, kept: trimmed.length });
}
```

- `render.ts` 对 `context_trim` 输出 dim 一行：`— context trimmed: N messages kept —`。
- **注意**：被裁掉的对话内容已从会话中删除，`session.getState()` 持久化的也是裁剪后的历史（与发送给模型的一致，避免恢复后模型看到从未见过或被裁的内容）。

### 4.5 与缓存策略（§5.2）的关系

- 不超预算时：消息只追加、前缀逐字不变 → Anthropic/OpenAI 缓存持续命中（现状已满足，有 `cache-stability.test.ts` 守护）。
- 裁剪触发时：前缀（system + 工具定义 + 早期消息）改变一次 → 该轮缓存 miss，之后在新前缀上重新累积命中。因为"稀触发、大步进"，miss 频率极低。
- 裁剪点永远在 turn 边界，`tool_call`/`tool_result` 配对完整，模型不会收到残缺的工具调用记录。

## 5. 配置

- `DaedalusConfig` 增加可选 `maxContextTokens?: number`；`resolveConfig` 支持 `DAEDALUS_MAX_CONTEXT_TOKENS` 环境变量。
- `EngineOptions.maxContextTokens` 默认 100_000（估算 token）。可下调以适配小窗口模型，或上调利用大窗口。

## 6. 文件结构

**新增：**
- `src/core/session-store.ts` —— `SessionStore`（`node:fs`/`node:os`/`node:path`）
- `src/agent/context.ts` —— `estimateTokens` + `trimHistory`
- `tests/core/session-store.test.ts`
- `tests/agent/context.test.ts`

**修改：**
- `src/core/session.ts` —— `getState`/`replaceMessages`/`restoreLoadedSkills`
- `src/core/engine.ts` —— `initialState`/`sessionStore`/`maxContextTokens`/`getSessionState`
- `src/core/skills/skill-tool.ts` —— 返回 `[Skill: ${name}]\n\n${body}`，与 `loadSkill` 注入格式统一（保护标记）
- `src/core/events.ts` —— `context_trim`
- `src/agent/loop.ts` —— 每轮迭代前调用 `trimHistory`，发 `context_trim`
- `src/config/config.ts` —— `maxContextTokens` + env
- `src/cli/main.ts` —— `--resume [id]`
- `src/cli/render.ts` —— 渲染 `context_trim`
- `src/core/index.ts` —— 导出新类型
- `README.md` —— 文档更新

**测试新增/扩展：**
- `tests/agent/context.test.ts` —— `trimHistory`：保留 system；丢最旧整 turn；不拆 `tool_call`/`tool_result`；`[Skill: ` 保护生效（引擎路径与工具路径两条注入形态）；`MIN_KEEP_TURNS` 兜底；预算建议性；返回值 `===` 判定；可注入 `estimate`/`isProtected`
- `tests/core/session-store.test.ts` —— 保存/加载往返；`list`/`latest`；原子写（模拟 tmp 残留）；损坏文件
- `tests/core/engine.test.ts` —— 从 `initialState` 恢复（消息逐字、skills 集合恢复不发 `skill_load`、无重复 system）；`sessionStore` 注入后 `run()` 自动保存；`context_trim` 在超预算时发出
- `tests/core/skills/skill-tool.test.ts` —— 断言 `[Skill: name]` 前缀与 body 一起返回
- `tests/config/config.test.ts` —— `DAEDALUS_MAX_CONTEXT_TOKENS` 解析

## 7. 任务拆解（实施顺序）

1. **Task A**：`src/agent/context.ts`（`estimateTokens` + `trimHistory`）+ `tests/agent/context.test.ts`。纯函数，独立可测。
2. **Task B**：`SessionStore` + `tests/core/session-store.test.ts`。
3. **Task C**：`Session` 改造（`getState`/`replaceMessages`/`restoreLoadedSkills`）+ `skill-tool.ts` 统一 `[Skill: ` 标记 + 各自测试扩展。
4. **Task D**：`engine.ts`（`initialState`/`sessionStore`/`getSessionState`/自动保存）+ `tests/core/engine.test.ts` 扩展。
5. **Task E**：`loop.ts` 裁剪接入 + `context_trim` 事件 + `render.ts` 渲染。
6. **Task F**：`config.ts` `maxContextTokens` + `main.ts --resume` + README + `tests/config/config.test.ts`。

每个 task 独立提交，遵循 SDD 评审门禁。

## 8. 后续（Roadmap 跟进，本设计不含）

- **模型驱动压缩**：裁剪接口已预留，后续可用一次低成本摘要调用把被裁区域缩成一条 user 消息替换，并保持新前缀稳定。
- **REPL `/sessions` / `/resume`**：需要 `EngineLike` 增加会话管理方法并处理会话切换事件，独立跟进。
- **真实 token 计数**：若未来允许依赖，可换 provider 提供的计数接口。
