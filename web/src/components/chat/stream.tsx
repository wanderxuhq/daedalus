import { createSignal, createEffect, onCleanup } from 'solid-js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({
  gfm: true,
  breaks: true,
});

const SANITIZE_OPTS = {
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr', 'ul', 'ol', 'li',
    'blockquote', 'pre', 'code', 'em', 'strong',
    'del', 'a', 'img', 'table', 'thead', 'tbody',
    'tr', 'th', 'td', 'div', 'span',
  ],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class'],
};

function renderMarkdown(text: string): string {
  const unsafeHtml = marked.parse(text) as string;
  const safeHtml = DOMPurify.sanitize(unsafeHtml, SANITIZE_OPTS);
  return safeHtml.replace(/<table/g, '<div class="table-wrap"><table').replace(/<\/table>/g, '</table></div>');
}

/** 模块级 throttle：所有 StreamText 共享，组件重建不影响。 */
const PARSE_INTERVAL_MS = 100;
let parseTimer: ReturnType<typeof setTimeout> | undefined;
let pendingText = '';
let activeSetHtml: ((v: string) => void) | undefined;
let hasRenderedOnce = false;

function flushParse(): void {
  parseTimer = undefined;
  if (activeSetHtml && pendingText) {
    activeSetHtml(renderMarkdown(pendingText));
    pendingText = '';
    hasRenderedOnce = false; // 下一轮第一个 token 立即渲染
  }
}

export function StreamText(props: { text: () => string }) {
  const [html, setHtml] = createSignal('');

  // 每次组件重建（token 到达 → 新引用 → <For> 重建）都注册最新的 setHtml
  activeSetHtml = setHtml;

  createEffect(() => {
    const text = props.text();
    pendingText = text;
    if (!hasRenderedOnce) {
      // 首次：立即渲染
      hasRenderedOnce = true;
      setHtml(renderMarkdown(text));
    } else if (parseTimer === undefined) {
      // 节流：100ms 内只渲染一次
      parseTimer = setTimeout(flushParse, PARSE_INTERVAL_MS);
    }
  });

  onCleanup(() => {
    if (activeSetHtml === setHtml) activeSetHtml = undefined;
  });

  return <div class="msg-text markdown-body" innerHTML={html()} />;
}
