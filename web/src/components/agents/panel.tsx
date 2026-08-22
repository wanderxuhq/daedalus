import { For } from 'solid-js';
import { DelegateRow } from '../chat/delegate-row.tsx';
import type { SubagentInfo } from '../../state-model.ts';

export function SubagentPanel(props: { subagents: SubagentInfo[] }) {
  return (
    <div class="subagents-panel">
      <h3>subagents</h3>
      <For each={props.subagents}>
        {(a) => <DelegateRow name={a.name} task={a.task} status={a.status} />}
      </For>
    </div>
  );
}
