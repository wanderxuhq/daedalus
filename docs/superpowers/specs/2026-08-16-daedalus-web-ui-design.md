# Daedalus — Web UI 设计文档

日期：2026-08-16
状态：草案

## 1. 概述

Daedalus 目前的交互层是**终端界面**（`src/cli/tui.ts` 全屏 TUI + `repl.ts` REPL）。用户决定转向 **Web UI** 作为主要交互方式：在浏览器里使用 Daedalus，手机和电脑都要有出色的体验，并且**不是"网页上套一个终端"**——而是要完整体现 Daedalus 的功能与特色：主对话、工具卡片、权限审批、会话管理、多 agent 协同。

运行方式参照 `../anther`：一个独立运行的 webapp——Node 原生 http 服务 + vite 前端，`npx`-风格入口，端口绑定，启动时打印本机与局域网访问地址。后期（不在本设计范围内）可能集成进 anther 作为侧边栏按钮模块。

设计遵循项目既有原则：**零重型框架**、引擎 UI 无关（`DaedalusEngine` 零改动或最小扩展）、`node:test` 零依赖测试、复用 anther 依赖与代码模式。

**核心定位：**

- **单用户、自用**：无鉴权，无需用户系统。
- **移动优先，桌面同优**：同一套响应式布局，手机/窄屏和桌面/宽屏分别有最佳形态。
- **不是终端**：不渲染 PTY、不用 xterm；一切以"对话 + 工具卡片 + 状态"为信息载体。
- **多 agent 协同是差异化**：主界面 = 主对话 + subagent 列表（无折叠/展开态）；点进某 subagent 进入独立详情页；agent 之间交流状态预留展示位。
- **复用现有引擎**：`CoreEvent` 事件流、`SessionStore`、`listSubagents` / `getSubagentMessages`、`setAskPermission` / `setAutoApprove` 全部直接复用。

## 2. 目标与非目标

### 包含

1. 内嵌 HTTP 服务（原生 `node:http` + 路由表 + 静态资源服务），仿 anther 的 `HttpServer`。
2. WebSocket 实时通道：把 `CoreEvent` 流式推给前端；连接时快照重放（刷新/重连不丢画面）。
3. 前端 `vite + solid-js` 单页应用：主对话 + subagent 面板/详情 + 会话列表三个视图。
4. 主对话流完整呈现 Daedalus 特色：流式文本、thinking 折叠、工具卡片（含 diff/错误）、delegate 活动行、权限内联卡片、会话事件行（compact/trim/skill）。
5. 权限审批：普通模式内联卡片（允许/拒绝），auto 模式全自动，UI 提供切换按钮。
6. 会话管理：新建/继续/重命名/删除，复用 `SessionStore`（补 `title` 字段）。
7. 移动端体验：底部输入区、窄屏抽屉、触摸友好的卡片与按钮。
8. 与现有 CLI 共存：新增 `daedalus web` 命令启动；TUI/REPL/`-p` 全部保留。

### 不包含（本轮，明确后置）

- **删除 TUI 与 REPL**——用户明确：等 Web UI 成熟后再说，本设计不动任何现有入口。
- **集成进 anther**（侧边栏按钮模块）——后续独立项目。
- **agent 间水平通信**（引擎能力）——用户明确"先设计 UI，UI 设计完再设计多 agent 交流"；本设计只在 subagent 详情页**预留**交流状态展示位，不实现引擎能力。
- **浏览器内编辑代码**（CodeMirror/LSP）——Daedalus 是 agent 界面不是编辑器；文件内容以工具卡片（read 内容 / diff）呈现。
- **鉴权/多用户/云端**。

## 3. 现状与动机

对照现有 CLI 各入口：

| # | 现状 | Web UI 的意义 |
|---|---|---|
| W1 | TUI 在 Termux 上软键盘调出/收起后失效（鼠标跟踪 DECSET 粘滞） | 网页输入框彻底摆脱终端按键问题 |
| W2 | 工具结果是 ANSI 卡片（`formatToolCard`） | 网页可渲染真正的富卡片：可展开 diff、错误高亮、状态徽标 |
| W3 | 权限是终端内联 y/n | 网页内联审批卡 + auto 切换按钮 |
| W4 | subagent 细节被 `HIDDEN_SUBAGENT_TYPES` 隐藏 | 网页把子代理内部事件流完整呈现（面板 + 详情页） |
| W5 | 会话列表只在 `/sessions` 文本命令里 | 网页有可视化会话管理（新建/继续/重命名/删除） |
| W6 | 手机访问需 Termux + 物理终端 | 局域网内手机浏览器直接访问 |

设计目标：W1–W6 全部解决；引擎层几乎零改动。

## 4. 总体架构

```
src/server/                          # 服务端（引擎进程内嵌）
├── http.ts            # HttpServer：node:http + 路由表 + 静态服务 + ws（复制精简 anther）
├── static.ts          # 静态目录解析（源码/产物路径兼容，仿 anther staticDirFor）
├── ws.ts              # WebSocket：快照 + CoreEvent 广播 + 权限请求/响应
├── server.ts          # 装配：config → AI client → engine → http → ws → 端口
├── permission.ts      # setAskPermission 的 Web 实现（内联卡片审批 + auto 短路）
└── routes/
    ├── chat.ts        # POST /api/chat：提交 prompt → engine.run（事件经 ws 推送）
    ├── sessions.ts    # GET/POST/DELETE /api/sessions（复用 SessionStore）
    ├── agents.ts      # GET /api/agents、/api/agents/<name>/messages
    └── config.ts      # GET/PUT /api/config（model/autoApprove/planMode）

web/                                   # 前端（vite + solid-js，仿 anther）
├── index.html
├── vite.config.ts
└── src/
    ├── main.tsx  App.tsx  routes.ts   # hash 路由：#/、#/agent/<name>、#/sessions
    ├── store.ts        # ws 事件 → 响应式 UI 状态（纯逻辑，可测）
    ├── ws.ts           # ws 客户端：快照应用 + 重连退避 + 消息分发
    ├── api.ts          # REST 封装（chat/sessions/config）
    ├── styles.css
    └── components/
        ├── topbar.tsx
        ├── chat/       # message / stream / tool-card / permission-card / delegate-row / event-line
        ├── agents/     # panel（subagent 列表）+ detail（#/agent/<name>）
        ├── sessions/   # list + row-menu（继续/重命名/删除）
        └── common/     # input / drawer / status-badge
```

**数据流：**

```
浏览器 ──REST──▶ src/server（engine.run）──CoreEvent──▶ ws.ts ──ws 消息──▶ 浏览器 store.ts ──▶ 组件渲染
               ▲                                               │
               ├── 权限响应 ◀──────── ws ──────────────────────┤
               └── config 切换 ◀────── REST（PUT /api/config）──┘
```

- **引擎单例常驻服务端**：`daedalus web` 启动即装配好 engine + SessionStore；`POST /api/chat` 一次一轮 `engine.run(prompt)`，事件流经 ws 推送。
- **ws 是事件主通道**：全部 `CoreEvent`（含 `agent` 字段）实时推送；前端按 `agent` 分流到主对话 / subagent 面板 / 详情页。
- **快照重放**：ws 连接建立时服务端发 `snapshot`（当前会话消息、subagent 列表、运行态、本轮未完成事件日志、挂起权限），前端应用后接实时流 → 手机刷新/断线重连画面不丢。
- **REST 管动作、ws 管推送**：提交 prompt、会话 CRUD、config 读写走 REST；事件、权限请求、权限响应走 ws（与 anther"REST 动作 + ws 流"模式一致）。

## 5. 实时通信协议

### 5.1 服务端 → 客户端（ws）

```
{ type: 'snapshot',
  messages,           // 当前会话消息（getSessionState().messages）
  subagents,          // listSubagents()
  running,            // 是否有本轮进行中（事件日志尾部 != done/error）
  log,                // 本轮尚未完成的 CoreEvent 列表（重放）
  pendingPermission } // 挂起的权限请求（若有）
{ type: 'event', ev } // 实时 CoreEvent（原样）
{ type: 'permission', id, action, target }   // 新挂起权限
{ type: 'permission_cancel', id }            // 权限被撤下（引擎结束等）
```

### 5.2 客户端 → 服务端（ws）

```
{ type: 'permission', id, allow: boolean, always?: boolean }  // 允许/拒绝/本轮始终允许
```

### 5.3 重连

- 断线 → 前端顶部显示"连接断开，重连中…"，指数退避自动重连；
- 重连成功 → 服务端发新 `snapshot`，前端整体重建状态，画面与进行中的本轮接上（沿用 anther"刷新重连"的已有体验）。

### 5.4 事件日志（快照重放的支撑）

- 服务端维护 `log: CoreEvent[]`，收到 `done`/`error` 清空；
- 连接建立时若 `running`，`snapshot.log` 携带全部未完成事件，前端按序重放 → 进行中的流式输出、工具进行中状态、delegate 行都不丢。

## 6. 前端设计（已逐节确认）

### 6.1 主界面（`#/`）

三区布局，移动优先：

```
┌─────────────────────────────────────────────────────────┐
│ 顶栏  会话标题（= 首条用户消息）   ● running   ⚙           │
├──────────────────────────────┬──────────────────────────┤
│ 主对话流                      │ subagents 面板（宽屏）      │
│  · 用户消息                    │  · 每项：名字 + 状态徽标     │
│  · 助手流式文本                │    + 消息数                │
│  · thinking（折叠）            │  · 点击 → 详情页            │
│  · 工具卡片（标题/状态/diff）    │                          │
│  · delegate 活动行            │ （窄屏：抽屉，左上角按钮）    │
│  · 权限卡片（普通模式）         │                          │
│  · 事件行（compact/trim/skill）│                          │
├──────────────────────────────┴──────────────────────────┤
│ 输入区  [text…                        ] [⏎] [auto 切换]   │
└─────────────────────────────────────────────────────────┘
```

- **顶栏**：会话标题、运行状态徽标、⚙（配置：model / auto / plan 切换）。
- **主对话流**是信息主体，各元素见 §6.3。
- **subagents 面板**：**无折叠/展开态**（用户明确）。宽屏常驻右侧；窄屏为抽屉（左上角按钮唤起）。每项显示 agent 名字、状态徽标（`●` 运行中 / `✓` 完成 / `✗` 失败 / `◇` 排队）、消息数；delegate_many 的多车道各自成行。点击 → `#/agent/<name>`。
- **输入区**：底部固定，多行自动增高；右侧 auto 切换按钮（普通模式 ↔ 全自动模式）；回车发送，Shift+Enter 换行；运行中禁用发送。
- **宽屏断点**（约 ≥1024px）：三区水平排布；窄屏：面板进抽屉。

### 6.2 subagent 详情页（`#/agent/<name>`）

```
┌────────────────────────────────────────────┐
│ ← 返回          subagent: <name>   ● 运行中  │
│ 任务：<delegate 传入的 task 摘要>            │
├────────────────────────────────────────────┤
│ 内部事件流（实时）：                          │
│  · 该 agent 的 text_delta / thinking_delta  │
│  · 工具卡片（子代理自己的工具调用）            │
│  · tool_result（含最终报告）                 │
│  · 消息数 / token 元信息                     │
├────────────────────────────────────────────┤
│ [预留：agent 间交流状态区 — 后续设计]          │
└────────────────────────────────────────────┘
```

- 数据来源：ws 事件流中 `agent === name` 的 tagged 事件（前端按 agent 分桶累积）+ `getSubagentMessages(name)` 拉历史（进页时补齐）。
- **不被 `HIDDEN_SUBAGENT_TYPES` 隐藏**（与 TUI 相反）——这正是 Web UI 相对 TUI 的能力提升：子代理内部细节完整可见。
- 底部预留"agent 间交流状态"区：本轮不实现引擎能力，但 UI 骨架留位（空态提示"agent 间交流：待开放"），避免后续破坏性改动。

### 6.3 主对话流元素

| 元素 | 行为 |
|---|---|
| 用户消息 | 右对齐气泡/块，含输入原文 |
| 助手文本 | 流式渲染（`text_delta` 追加），完成态定格 |
| thinking | 折叠行（▶/▼），点击展开，默认收起；内容灰字 |
| 工具卡片 | 标题（`工具名`）+ 状态（进行中 spinner / 完成 ✓ / 失败 ✗）+ 输入摘要；`tool_result` 内容可展开（read 内容、bash 输出、write diff 用 `<pre>` 显示），`isError` 红边；diff 用简单高亮（`unifiedDiff` 输出 + 增减行着色） |
| delegate 活动行 | `→ subagent [name]` + 任务摘要；状态随徽标变化；点击跳详情页 |
| 权限卡片 | 内联于流中：`工具名 · 目标摘要` + [允许] [拒绝] [本轮始终允许]；auto 模式下不出现（服务端短路） |
| 事件行 | compact/trim/skill 等系统提示，弱化样式 |

### 6.4 会话列表（`#/sessions`）

- 列表项：**标题 = 首条用户消息**（截断）、更新时间、消息数；
- 每项 `···` 菜单：继续（回到 `#/` 并 resume）/ 重命名 / 删除（确认后再删）；
- 顶部 `[+ 新建]`：清空当前会话状态开始新对话；
- 数据来自 `SessionStore`（同一磁盘目录，与 TUI/REPL 互通）；`listSessions()` 已有，**补 `title` 字段**（见 §7）。

## 7. 会话与状态管理

### 7.1 复用现状

- 引擎在每次 `run` 结束自动 `sessionStore.save`（现有行为），Web UI 免费获得持久化；
- `engine.resume(id)`、`engine.getSessionState()`、`engine.listSessions()` 直接复用；
- `engine.clearConversation()` 作为"新建会话"的服务端动作。

### 7.2 最小扩展：`SessionStore` 补 title

当前 `SessionMeta = { id, updatedAt, messageCount }`，没有标题。会话列表需要"标题 = 首条用户消息"。方案：

- `StoredSession` / `SessionMeta` 增加可选 `title?: string`；
- `save()` 时从 `state.messages` 的首条用户消息截断（≤80 字符）生成默认 title；
- 新增 `SessionStore.rename(id, title)`：重写存储文件的 `title` 字段；
- **向后兼容**：旧文件无 `title`，`list()` 时降级为 `load` 取首条用户消息或"未命名会话"。

这是唯一的存储层改动；引擎层零改动（`remove`、`latest` 已存在）。

### 7.3 并发控制

`engine.run` 不支持并发执行：服务端在运行中拒绝新的 `POST /api/chat`（409 "已有任务运行中"）；前端运行中禁用发送框（双保险）。

## 8. 权限审批机制

复用引擎现有能力，零引擎改动：

```
服务端 permission.ts：
  engine.setAskPermission(async (action, target) => {
    if (engine.getAutoApprove()) return true;              // auto 模式：全自动（C）
    const id = nextId();
    // 普通模式（A）：推给前端，挂起直到 ws 返回审批结果
    return await new Promise<boolean>((res) => {
      pending.set(id, (allow: boolean) => res(allow));     // 挂起映射
      broadcast({ type: 'permission', id, action, target });
    });
  });
  // ws 收到 { type:'permission', id, allow, always }
  //   取出并删除 pending 条目 → always → engine.setAutoApprove(true)；随后 settle(allow)
```

- **普通模式（A）**：内联权限卡片（§6.3），点允许/拒绝。
- **auto 模式（C）**：`setAskPermission` 直接短路 `true`，卡片不出现。
- **UI 切换按钮**：输入区右侧 toggle → `PUT /api/config { autoApprove }` → `engine.setAutoApprove`，服务端读取实时生效。
- 卡片挂起期间工具调用等待，不阻塞其他事件流（现有队列语义由引擎保证）。
- `done`/`error` 时清理全部挂起权限并广播 `permission_cancel`（防止幽灵卡片）。

## 9. 服务端 API

### 9.1 REST 路由

| 方法/路径 | 行为 |
|---|---|
| `POST /api/chat` `{prompt}` | `engine.run(prompt)`；返回 `{status, result}`；运行中 → 409；事件经 ws 推送 |
| `GET /api/sessions` | `listSessions()`（含 title） |
| `POST /api/sessions` `{id}` | resume 指定会话；无 body → 新会话（`clearConversation`） |
| `PUT /api/sessions/:id` `{title}` | `SessionStore.rename` |
| `DELETE /api/sessions/:id` | `SessionStore.remove` |
| `GET /api/agents` | `listSubagents()` |
| `GET /api/agents/:name/messages` | `getSubagentMessages(name)` |
| `POST /api/agents/:name/close` | `closeSubagent(name)` |
| `GET /api/config` | `{model, autoApprove, planMode, thinking}` |
| `PUT /api/config` | 切换 `autoApprove` / `planMode` / `model`（`setAutoApprove`/`setPlanMode`/`setModel`） |
| `GET /api/state` | 完整快照（无 ws 时的页面加载兜底 + 便于测试） |

### 9.2 HttpServer（仿 anther 复制精简）

从 anther 复制 `HttpServer`（`node:http` + 方法路由表 + `ws` 路由 + 静态服务 + SPA fallback），精简掉本设计用不到的能力：

- **去掉 SSE 路由**（本设计用 ws 推送）；
- **去掉多用户**（无 `x-user-id` 概念）；
- 保留：静态服务 + SPA fallback（深链 `#/sessions` 直接刷新可打开）、`readBody` 的 1MB 上限与 JSON 解析、`HttpError` 语义。

### 9.3 静态目录

沿用 anther `staticDirFor` 技巧：

- 开发（`src/server/server.ts`）→ `<root>/web`；
- 构建产物（`dist/server/server.js`）→ `<root>/dist/web`；
- 通过 `path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web')` 同时覆盖两形态，`import.meta.dirname` 的产物陷阱在 anther 已踩平，照抄。

## 10. 运行模式与 CLI 共存

### 10.1 启动

```
daedalus web [--port 3000] [--provider …] [--model …]
```

- 新增 `web` 子命令 → `server.ts`；参数与现有 CLI 一致（flags 复用 `parseFlags`，`--port` 为 web 子命令新增选项，`parseFlags` 小扩展）；
- 默认端口 3000（`DAEDALUS_WEB_PORT` / `--port` 覆盖）；
- 启动日志（仿 anther）：`daedalus web started: http://localhost:3000` + `LAN access: http://<ip>:3000`（`lanIPv4`）；
- `bin` 入口沿用（`dist/cli/main.js` → 分派 `web` 子命令）。

### 10.2 脚本

| 脚本 | 行为 |
|---|---|
| `npm run dev` | 一键前后端（仿 anther `scripts/dev.mjs`：后端 `node --watch` + 前端 vite，同终端，进程组清理） |
| `npm run dev:server` / `dev:web` | 分开发 |
| `npm run build` | `tsc` + `vite build`（outDir `dist/web`） |
| `npm test` | `node --test --experimental-transform-types 'tests/**/*.test.ts' 'web/src/**/*.test.ts'` |

vite dev 代理 `/api`（含 `ws: true`）到后端 3000；`host: true` 供手机访问；`os.networkInterfaces()` 的 EACCES 兜底照抄 anther（受限环境不崩）。

### 10.3 共存边界

- TUI / REPL / `-p` 单次模式**完全不动**（代码、flag、行为）；
- `daedalus`（无子命令）仍进 TUI/REPL；
- Web 与 CLI 共享同一 `SessionStore` 目录，会话互通。

## 11. 测试策略（node:test，零新增框架）

| 层 | 测试 |
|---|---|
| `server/permission.ts` | auto 短路 / 挂起映射 / always→autoApprove / 清理 |
| `server/routes/*` | 用**假 AI client**（scripted `AiClient`，注入 `createAiClient`）驱动完整 `engine.run` 流程：文本流、工具调用、权限、子代理、会话 CRUD、409 并发 |
| `server/http.ts` | 路由表、静态服务 + SPA fallback、深链刷新、1MB 上限 |
| `server/ws.ts` | snapshot 重放（中途连接接住进行中本轮）、重连快照、权限请求/响应往返 |
| `web/store.ts` | 事件流 → UI 状态归并（纯函数）：`text_delta` 累积、工具卡状态机、permission 挂起、delegate 分桶、done 定格；**这是前端核心，重点覆盖** |
| `web/ws.ts` | 消息解码、重连退避、快照应用 |
| `web/api.ts` | REST 封装（错误/409） |

- 前端只测**纯逻辑**（store/ws/api），不引入 jsdom / testing-library——anther 的 web 测试同此策略；
- 测试工具用 `node:test` + `--experimental-transform-types`（anther 同款）。

## 12. 依赖清单（复用 anther，未用到的待确认）

复用，加入 `package.json`：

| 依赖 | 用途 |
|---|---|
| `solid-js ^1.9.14` | 前端响应式 UI |
| `ws ^8.21.3` | 服务端 WebSocket 实时通道 |
| `vite ^6.4.3`（devDep） | 前端构建/开发服务器 |
| `vite-plugin-solid ^2.11.14`（devDep） | solid-js vite 插件 |

未使用（**初始不引入，待确认**）：

| 依赖 | 为何不用 |
|---|---|
| `@codemirror/*` + `codemirror` | 浏览器内代码编辑——本设计不做编辑器（工具卡片 `<pre>` + diff 高亮足矣） |
| `@xterm/xterm` + `@xterm/addon-fit` | 终端仿真——明确不做"网页套终端" |
| `typescript-language-server` + `vscode-languageserver-protocol` | LSP——依赖编辑能力，同上 |

（`@anthropic-ai/tokenizer` 是 Daedalus 现有依赖，与 anther 无关。）

## 13. 迁移路径与阶段划分

每阶段独立落地、不回归，沿用 SDD 流程（spec → plan → 实施）。

**Phase 0 — 骨架与通道**
`server/http.ts`（复制精简）+ `static.ts` + `server.ts` 装配（config→client→engine→http→ws）；`web/` vite+solid 搭起；`daedalus web` 可启动、静态页可访问；ws 快照 + 事件流打通（页面上能看到 `text_delta` 流式文本）。`SessionStore` 补 `title`/`rename`。**验收：`daedalus web` 起服务，浏览器看到会话快照与流式事件。**

**Phase 1 — 主对话流**
store.ts 事件归并 + 组件：消息、流式输出、thinking 折叠、工具卡、delegate 行、事件行、权限卡 + auto 切换、输入区（发送/换行/禁用）。**验收：完整一轮对话（含工具调用 + 权限审批）在浏览器跑通。**

**Phase 2 — 多 agent 视图**
subagents 面板（宽屏常驻 / 窄屏抽屉）+ 详情页 `#/agent/<name>`（内部事件流 + 历史拉取 + 状态徽标 + 预留交流区）。**验收：`delegateMany` 多车道并行时面板与详情实时、手机窄屏抽屉可用。**

**Phase 3 — 会话管理**
`#/sessions` 列表 + 新建/继续/重命名/删除；与 TUI/REPL 会话互通验证。**验收：会话 CRUD 全流程。**

**Phase 4 — 打磨（Roadmap 可裁剪）**
重连体验细化、错误处理、移动端手感（触摸目标、输入框安全区）、断网提示、主题、性能（流式渲染节流）。

**后置（不在本设计）**：删除 TUI/REPL、anther 集成、agent 间交流引擎能力。

每阶段结束更新 README 的 Web UI 描述。

## 14. 开放问题

1. **快照重放的粒度**：`log` 事件日志是否要持久化到"本轮失败后刷新"也能重放完整工具调用？倾向只做内存日志（进程活着即可），崩溃场景由会话消息兜底（工具结果已入消息历史）。
2. **权限卡在 auto 模式下的显示**：auto 模式完全不显示卡片，还是显示"已自动允许"的灰色记录？倾向完全不显示（模式切换按钮即状态表达）。
3. **工具卡 diff 高亮**：自写简单的统一 diff 行着色，还是引入 diff 库？倾向自写（`unifiedDiff` 输出已有 + 增减行前缀着色，几行代码）。
4. **`GET /api/sessions` 的 title 降级**：旧会话文件无 title 时，`list()` 是否逐个 `load` 取首条消息？会话数量少（个位数~几十）可接受；数量大再议。
5. **端口与多实例**：同一台机器同时跑 `daedalus web` 与 anther（都默认 3000）会撞端口；是否默认端口差异化（如 daedalus 用 3100）？倾向 daedalus 默认 3100 并支持 `--port`。

## 15. 附录：目标文件结构

```
src/
├── server/
│   ├── http.ts  static.ts  ws.ts  server.ts  permission.ts
│   └── routes/  (chat.ts / sessions.ts / agents.ts / config.ts)
├── cli/                    # 不变；main.ts 增 web 子命令分派
└── core/  tools/  ai/      # 不变；SessionStore 补 title/rename
web/
├── index.html  vite.config.ts  tsconfig.json
└── src/
    ├── main.tsx  App.tsx  routes.ts  store.ts  ws.ts  api.ts  styles.css
    └── components/  (topbar / chat/* / agents/* / sessions/* / common/*)
scripts/
└── dev.mjs                # 一键前后端（仿 anther）
tests/
└── server/  web/          # 镜像 src/server 与 web/src 结构
```
