import { Badge } from '../common/badge.tsx';
export function DelegateRow(props: { name: string; task: string; status: 'running' | 'done' | 'error' | 'queued'; onAbort?: (name: string) => void }) {
  return (
    <div class="delegate-row-content">
      <Badge status={props.status} />
      <span class="delegate-name">subagent [{props.name}]</span>
      {props.status === 'running' && props.onAbort && (
        <button class="abort-btn" onClick={(e) => { e.stopPropagation(); props.onAbort!(props.name); }} title="Stop">⏹</button>
      )}
    </div>
  );
}
