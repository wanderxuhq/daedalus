import { Badge } from '../common/badge.tsx';
export function DelegateRow(props: { name: string; task: string; status: 'running' | 'done' | 'error' | 'queued' }) {
  return (
    <div class="delegate-row-content">
      <Badge status={props.status} />
      <span class="delegate-name">subagent [{props.name}]</span>
      {props.task && <span class="delegate-task">{props.task}</span>}
    </div>
  );
}
