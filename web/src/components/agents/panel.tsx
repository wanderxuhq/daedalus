import { For, Show } from 'solid-js';
import { DelegateRow } from '../chat/delegate-row.tsx';
import type { SubagentInfo } from '../../state-model.ts';
import { t } from '../../i18n.ts';

export function SubagentPanel(props: {
  subagents: SubagentInfo[];
  onAbort?: (name: string) => void;
}) {
  return (
    <div class="subagents-panel">
      <div class="subagents-panel-header">
        <h3>{t('subagents.title')}</h3>
      </div>
      <For each={props.subagents}>
        {(a) => (
          <div
            class="delegate-row clickable"
            onClick={() => { location.hash = `#/agent/${encodeURIComponent(a.name)}`; }}
          >
            <DelegateRow name={a.name} task={a.task} status={a.status} onAbort={props.onAbort} />
          </div>
        )}
      </For>
      <Show when={props.subagents.length === 0}>
        <div class="empty-panel">{t('subagents.empty')}</div>
      </Show>
    </div>
  );
}
