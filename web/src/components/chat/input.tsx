import { createSignal } from 'solid-js';
export function ChatInput(props: { disabled: boolean; autoApprove: boolean; onSend: (prompt: string) => void; onToggleAuto: () => void }) {
  const [text, setText] = createSignal('');
  const submit = () => {
    const t = text().trim();
    if (!t || props.disabled) return;
    props.onSend(t);
    setText('');
  };
  return (
    <div class="chat-input">
      <textarea
        rows={1}
        value={text()}
        placeholder={props.disabled ? '运行中…' : '输入消息'}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
        }}
      />
      <button class="send-btn" onClick={submit} disabled={props.disabled}>⏎</button>
      <button class="auto-toggle" classList={{ 'auto-on': props.autoApprove }} onClick={props.onToggleAuto} title="权限模式切换">
        {props.autoApprove ? 'auto' : 'ask'}
      </button>
    </div>
  );
}
