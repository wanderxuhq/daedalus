import { createSignal, onCleanup } from 'solid-js';
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

/** Throttle: only re-parse markdown at most once per PARSE_INTERVAL_MS. */
const PARSE_INTERVAL_MS = 100;

export function StreamText(props: { text: string }) {
  const [html, setHtml] = createSignal('');
  let lastRenderedText = '';

  // 轮询 props.text（getter 始终返回原地修改后的最新值），
  // 每 PARSE_INTERVAL_MS 检查一次是否有变化，有则重新解析 markdown。
  // 不依赖 SolidJS 响应式——因为 content 数组项是原地修改，引用不变，effect 不会重跑。
  const timer = setInterval(() => {
    const latest = props.text;
    if (latest !== lastRenderedText) {
      lastRenderedText = latest;
      setHtml(renderMarkdown(latest));
    }
  }, PARSE_INTERVAL_MS);

  // 首次挂载立即解析一次，不等 timer
  lastRenderedText = props.text;
  setHtml(renderMarkdown(props.text));

  onCleanup(() => clearInterval(timer));

  return <div class="msg-text markdown-body" innerHTML={html()} />;
}
