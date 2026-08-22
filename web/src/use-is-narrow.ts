import { createSignal, onCleanup } from 'solid-js';

const NARROW_QUERY = '(max-width: 1023px)';

/** 窄屏信号（≤1023px）：App 与 Drawer 共用。 */
export function useIsNarrow(): () => boolean {
  const [narrow, setNarrow] = createSignal(
    typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches,
  );
  if (typeof window !== 'undefined') {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    onCleanup(() => mq.removeEventListener('change', onChange));
  }
  return narrow;
}
