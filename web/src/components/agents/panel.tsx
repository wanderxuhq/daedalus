import { For, Show } from 'solid-js';
import { DelegateRow } from '../chat/delegate-row.tsx';
import type { SubagentInfo } from '../../state-model.ts';
import { t } from '../../i18n.ts';

export function SubagentPanel(props: {
  subagents: SubagentInfo[];
  viewingSubagent?: string | null;
  onView?: (name: string) => void;
  onReturnToMain?: () => void;
  onAbort?: (name: string) => void;
  currentSessionTitle?: string;
}) {
  return (
    <div class="subagents-panel">
      <div class="subagents-panel-header">
        <h3>{t('subagents.title')}</h3>
      </div>
      <Show when={props.currentSessionTitle !== undefined}>
        <div class="session-current">
          <span class="session-current-title">{t('subagents.currentSession')}</span>
          <span class="session-current-name">{props.currentSessionTitle}</span>
        </div>
      </Show>
      <For each={props.subagents}>
        {(a) => (
          <div
            class={`delegate-row ${props.onView ? 'clickable' : ''} ${props.viewingSubagent === a.name ? 'active' : ''}`}
            onClick={() => props.onView?.(a.name)}
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
