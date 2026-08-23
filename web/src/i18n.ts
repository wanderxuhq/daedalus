/** Lightweight i18n — no dependencies, browser auto-detect, localStorage persistence. */

const en: Record<string, string> = {
  // App
  'app.title': 'daedalus',
  'app.reconnect': 'Disconnected, reconnecting…',

  // Drawer
  'drawer.mainSession': '💬 Main Session',
  'drawer.subagents': '🤖 Subagents',

  // Subagent panel
  'subagents.title': 'Subagents',
  'subagents.currentSession': 'Current Session ✓',
  'subagents.empty': 'No subagents yet',

  // Agent detail
  'agent.back': '← Back',
  'agent.interAgent': 'Inter-agent communication: coming soon',

  // Chat input
  'input.loadFailed': 'Failed to load session list',
  'input.restoreSession': 'Restore Session',
  'input.noSessions': 'No sessions',
  'input.items': 'items',
  'input.running': 'Running…',
  'input.placeholder': 'Enter message',
  'input.togglePermission': 'Toggle permission mode',

  // Permission card
  'permission.allow': 'Allow',
  'permission.alwaysAllow': 'Always allow this turn',
  'permission.reject': 'Reject',

  // Sessions
  'sessions.back': '← Back',
  'sessions.title': 'Sessions',
  'sessions.new': '[+ New]',
  'sessions.items': 'items',
  'sessions.rename': 'Rename',
  'sessions.delete': 'Delete',
  'sessions.confirmDelete': 'Confirm delete "{title}"?',
  'sessions.cancel': 'Cancel',
};

const zhCN: Record<string, string> = {
  // App
  'app.title': 'daedalus',
  'app.reconnect': '连接断开，重连中…',

  // Drawer
  'drawer.mainSession': '💬 主会话',
  'drawer.subagents': '🤖 子代理',

  // Subagent panel
  'subagents.title': '子代理',
  'subagents.currentSession': '当前会话 ✓',
  'subagents.empty': '暂无子代理',

  // Agent detail
  'agent.back': '← 返回',
  'agent.interAgent': 'agent 间交流：待开放',

  // Chat input
  'input.loadFailed': '加载会话列表失败',
  'input.restoreSession': '恢复对话',
  'input.noSessions': '暂无会话',
  'input.items': '条',
  'input.running': '运行中…',
  'input.placeholder': '输入消息',
  'input.togglePermission': '权限模式切换',

  // Permission card
  'permission.allow': '允许',
  'permission.alwaysAllow': '本轮始终允许',
  'permission.reject': '拒绝',

  // Sessions
  'sessions.back': '← 返回',
  'sessions.title': '会话',
  'sessions.new': '[+ 新建]',
  'sessions.items': '条',
  'sessions.rename': '重命名',
  'sessions.delete': '删除',
  'sessions.confirmDelete': '确认删除「{title}」？',
  'sessions.cancel': '取消',
};

const langs: Record<string, Record<string, string>> = { en, 'zh-CN': zhCN };

function detect(): string {
  try {
    const stored = localStorage.getItem('daedalus-lang');
    if (stored && langs[stored]) return stored;
  } catch { /* SSR / private browsing */ }
  const nav = navigator.language;
  if (langs[nav]) return nav;
  // zh-*, zh_* → zh-CN
  if (nav.startsWith('zh')) return 'zh-CN';
  return 'en';
}

let current = detect();

export function t(key: string, params?: Record<string, string>): string {
  let s = langs[current]?.[key] ?? langs.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, v);
  }
  return s;
}

export function setLanguage(lang: string): void {
  if (!langs[lang]) return;
  current = lang;
  try { localStorage.setItem('daedalus-lang', lang); } catch { /* ignore */ }
}

export function getLanguage(): string {
  return current;
}

export function availableLanguages(): { code: string; label: string }[] {
  return [
    { code: 'en', label: 'English' },
    { code: 'zh-CN', label: '简体中文' },
  ];
}
