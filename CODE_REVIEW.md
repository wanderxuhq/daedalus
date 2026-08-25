# Daedalus 代码审查报告

## 概述
本报告是对 Daedalus 代码库的全面审查，涵盖 AI 层、代理循环、核心引擎、会话管理等关键模块。审查重点关注代码质量、设计模式、潜在 bug 和改进建议。

## 总体评价
代码库质量很高，架构设计精良，体现了良好的工程实践。主要亮点包括清晰的层次分离、健壮的事件系统、优秀的错误处理和生产级的 SSE 解析器。以下是按严重程度分类的发现。

## 🔴 潜在 Bug（建议优先修复）

### 1. OpenAI 适配器丢弃文本内容
**文件**: `src/ai/openai.ts`
**问题**: 当 OpenAI 返回同时包含 `content` 和 `tool_calls` 的助手消息时，代码将 `content` 硬置为 `null`，丢失了文本内容。这在并行函数调用场景中可能发生。
**影响**: 可能丢失重要的文本响应。
**建议修复**:
```typescript
if (calls.length) {
  if (!text) msg.content = null;
  msg.tool_calls = calls.map(...)
}
```

### 2. AiError.retryable 绕过只读保护
**文件**: `src/ai/http.ts`
**问题**: 通过 `(err as { retryable: boolean }).retryable = false` 修改只读属性，破坏了类型契约。
**影响**: 类型安全被破坏，未来重构可能导致运行时错误。
**建议修复**: 修改构造函数或添加 `withRetryable(false)` 方法。

### 3. 代理循环 finalText 可能过时
**文件**: `src/agent/loop.ts`
**问题**: `finalText` 在循环外声明，当最后一次迭代只有工具调用时，可能返回前一次迭代的文本。
**影响**: 返回给用户的最终文本可能不正确。
**建议修复**: 在循环内每次迭代重置 `finalText`。

### 4. Consult 工具不转发模型覆盖
**文件**: `src/core/consult.ts`
**问题**: 用户通过 `/model` 设置的模型覆盖不会传递给 consult 克隆体。
**影响**: Consult 使用默认模型而非用户指定的模型。
**建议修复**: 在 `ConsultToolOptions` 中添加 `model` 属性并传递。

### 5. Skill 工具不注入技能体到会话
**文件**: `src/core/skills/skill-tool.ts`
**问题**: 通过 Skill 工具加载的技能体可能被截断（30K 字符限制），且不受修剪保护。
**影响**: 技能体可能不完整，且在上下文修剪时可能被丢弃。
**建议修复**: 调用 `session.addMessage()` 注入完整的技能体。

### 6. 缓存键检测弱
**文件**: `src/core/delegate.ts`
**问题**: `conversationFingerprint` 仅使用消息数量和首尾消息的前20个字符，中间编辑无法使缓存失效。
**影响**: 可能导致子代理使用过时的摘要。
**建议修复**: 使用更完整的指纹，如消息内容的哈希值。

## 🟡 设计问题与代码异味

### 7. 上下文修剪魔法数字
**文件**: `src/agent/context.ts`
**问题**: 硬编码的 `0.75` 修剪目标应提取为可配置常量。
**建议**: 提取为 `TRIM_TARGET_RATIO = 0.75` 常量。

### 8. 事件总线无错误边界
**文件**: `src/core/events.ts`
**问题**: 抛出异常的处理器会中断后续所有处理器。
**建议**: 在 `emit` 方法中为每个处理器添加 try/catch。

### 9. SkillRegistry 同步 I/O
**文件**: `src/core/skills/registry.ts`
**问题**: 使用 `readdirSync`、`readFileSync` 阻塞事件循环。
**建议**: 考虑异步 I/O 或缓存结果。

### 10. 文件锁清理不对称
**文件**: `src/core/file-lock.ts`
**问题**: `clear()` 丢弃活动锁，但持有者仍认为自己持有锁。
**建议**: 在清理时通知所有锁持有者，或添加文档说明。

### 11. 代理循环双重提取
**文件**: `src/agent/loop.ts`
**问题**: `pendingDone` 和 `lastAssistant` 通过两次独立扫描获取，虽然当前安全但脆弱。
**建议**: 重构为单次扫描提取两个引用。

### 12. 压缩模块重复代码
**文件**: `src/agent/compact.ts`
**问题**: `summarizeTurns` 和 `summarizeMainForTask` 几乎重复。
**建议**: 提取共享的流式处理辅助函数。

## 🟢 改进建议

### 13. 类型定义过于宽松
**文件**: `src/ai/types.ts`
**问题**: `ToolDefinition.inputSchema: unknown` 应至少为 `Record<string, unknown>`。
**建议**: 修改类型定义以提供更好的类型提示。

### 14. 错误处理不一致
**文件**: `src/agent/loop.ts`
**问题**: `(e as Error).message` 假设所有抛出值都是 Error 实例。
**建议**: 使用 `e instanceof Error ? e.message : String(e)`。

### 15. 令牌估算回退启发式
**文件**: `src/agent/tokenizer.ts`
**问题**: `Math.ceil(text.length / 4)` 对代码内容可能低估。
**建议**: 考虑改为 `Math.ceil(text.length / 3)` 以更安全地估算代码令牌。

## 📊 亮点（做得好的地方）

1. **精心设计的架构**：清晰的层次分离（主代理 → 委托 → 子代理）
2. **健壮的事件系统**：使用判别联合类型，无 `any` 转换
3. **优秀的错误处理**：`AiErrorKind` + `RETRYABLE` 集合简洁可扩展
4. **生产级 SSE 解析器**：per-chunk 超时防止提供商假死
5. **智能上下文管理**：自动压缩 → 硬修剪的双重策略
6. **写者优先的读写锁**：正确防止饥饿并通过超时打破死锁
7. **字节相同的前缀克隆**：保留跨克隆的提示缓存命中
8. **代理循环回滚机制**：基于身份的回滚避免崩溃后的孤立提示
9. **Hook 系统**：咨询语义，钩子从不中断代理
10. **PersistentShell**：fd-3 命令管道协议、nonce 分隔符和 EPIPE 重试机制

## 📋 建议修复优先级

1. **立即修复**：#1（OpenAI文本丢失）、#4（consult模型覆盖）、#5（skill注入）
2. **高优先级**：#2（只读绕过）、#3（finalText过时）、#6（缓存键）
3. **中优先级**：#7-#12（设计问题）
4. **低优先级**：#13-#15（改进建议）

## 结论
Daedalus 是一个设计精良、代码质量高的项目。最需要关注的是 OpenAI 适配器的文本丢失问题和 consult/skill 工具的模型覆盖传递。建议在修复这些 bug 后，再处理设计异味和代码风格问题。整体架构和实现展示了专业的工程水平。