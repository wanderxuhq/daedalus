import type { CoreEvent } from '../../src/core/events.ts';

export type EventEnvelope =
  | { type: 'event'; ev: CoreEvent }
  | ({ type: 'snapshot' } & SnapshotPayload)
  | { type: 'permission'; id: string; action: string; target: string }
  | { type: 'permission_cancel'; id: string };

export type ChatResult = { status: 'ok'; result: string } | { status: 'error'; error: string };

export interface SnapshotPayload {
  messages: unknown[];
  subagents: Array<{ name: string; task: string; status: string; messageCount: number; loadedSkills: string[] }>;
  running: boolean;
  log: CoreEvent[];
  pendingPermission: { id: string; action: string; target: string } | null;
}
