export function Badge(props: { status: 'running' | 'done' | 'error' | 'queued' }) {
  const sym = { running: '●', done: '✓', error: '✗', queued: '◇' }[props.status];
  const cls = `badge badge-${props.status}`;
  return <span class={cls} title={props.status}>{sym} {props.status}</span>;
}
