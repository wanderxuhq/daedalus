import type { ChatResult } from './types.ts';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export async function chat(prompt: string): Promise<ChatResult> {
  try {
    const r = await request<{ status: 'ok'; result: string }>('POST', '/api/chat', { prompt });
    return { status: 'ok', result: r.result };
  } catch (e) {
    return { status: 'error', error: (e as Error).message };
  }
}

export async function getSubagentMessages(name: string): Promise<unknown[]> {
  const r = await request<{ messages: unknown[] }>('GET', `/api/agents/messages?name=${encodeURIComponent(name)}`);
  return r.messages;
}
export async function closeSubagent(name: string): Promise<void> {
  await request('POST', '/api/agents/close', { name });
}
export async function listSessions(): Promise<Array<{ id: string; title: string; updatedAt: string; messageCount: number }>> {
  const r = await request<{ sessions: Array<{ id: string; title: string; updatedAt: string; messageCount: number }> }>('GET', '/api/sessions');
  return r.sessions;
}
export async function renameSession(id: string, title: string): Promise<void> {
  await request('PUT', '/api/sessions/rename', { id, title });
}
export async function deleteSession(id: string): Promise<void> {
  await request('POST', '/api/sessions/delete', { id });
}
export async function resumeSession(id: string): Promise<void> {
  await request('POST', '/api/sessions', { id });
}
export async function getConfig(): Promise<{ model: string | null; autoApprove: boolean; planMode: boolean }> {
  return request('GET', '/api/config');
}
export async function putConfig(patch: { autoApprove?: boolean; planMode?: boolean; model?: string }): Promise<void> {
  await request('PUT', '/api/config', patch);
}

/** 给子代理发消息。 */
export async function chatAgent(name: string, prompt: string): Promise<ChatResult> {
  try {
    await request('POST', '/api/agents/chat', { name, prompt });
    return { status: 'ok', result: '' };
  } catch (e) {
    return { status: 'error', error: (e as Error).message };
  }
}


