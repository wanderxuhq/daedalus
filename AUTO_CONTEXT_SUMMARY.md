# Auto Context Summary for Subagent Delegation

## Overview

This feature automatically summarizes the main conversation history with focus on the delegated task, then injects it into the subagent's context. This avoids redundant work and improves context relevance for subagents.

## How It Works

When a delegate tool call is made:

1. **Task-Specific Summarization**: The system creates a summary of the main conversation history using a task-specific prompt that focuses on information relevant to the delegated task.

2. **Context Injection**: The summary is injected into the subagent's context as a `[Main conversation summary]` block before the task description.

3. **Error Handling**: If summarization fails, the system gracefully falls back to proceeding without context (non-fatal error).

## Usage

The feature is enabled by default in `DaedalusEngine`. To disable it:

```typescript
const engine = new DaedalusEngine({
  // ... other options
  enableAutoSummary: false, // Disable auto-context-summary
});
```

## Configuration Options

### DelegateToolOptions

- `getMainHistory?: () => Message[]` - Function to get the main conversation history
- `enableAutoSummary?: boolean` - Enable/disable auto-summarization (default: true)

### EngineOptions

- `enableAutoSummary?: boolean` - Enable/disable auto-summarization for the engine (default: true)

## Implementation Details

### Files Modified

1. **`src/agent/compact.ts`**:
   - Added `buildTaskSummarySystem(task)` function
   - Added `summarizeMainForTask(client, mainHistory, task)` function

2. **`src/core/delegate.ts`**:
   - Added `getMainHistory` and `enableAutoSummary` to `DelegateToolOptions`
   - Modified `runOnce` function to call `summarizeMainForTask` when enabled

3. **`src/core/engine.ts`**:
   - Added `enableAutoSummary` to `EngineOptions`
   - Modified `delegateOptions` creation to pass `getMainHistory` and `enableAutoSummary`

### Testing

- Added 5 new tests for `summarizeMainForTask` function
- Updated existing tests to disable auto-summary for testing
- All 420 tests pass

## Cache Impact

- **Main conversation cache**: Unaffected (read-only access)
- **Subagent cache**: Summary is appended to history (append-only design)
- **Summary call itself**: Uses `cache: { enabled: false }` for one-time call

## Benefits

1. **Reduces Redundant Work**: Subagents don't need to re-explore information already discussed
2. **Improves Context Relevance**: Summaries focus on task-relevant information
3. **Better Token Usage**: More efficient use of subagent's context window
4. **Graceful Degradation**: Falls back to no context if summarization fails
