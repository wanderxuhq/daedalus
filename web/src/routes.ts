export type Route = { route: 'main' } | { route: 'agent'; name: string } | { route: 'sessions' };

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '').replace(/\/$/, '');
  if (h === '') return { route: 'main' };
  if (h === 'sessions') return { route: 'sessions' };
  const m = /^agent\/(.+)$/.exec(h);
  if (m) return { route: 'agent', name: decodeURIComponent(m[1]) };
  return { route: 'main' };
}

export function onHashChange(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}
