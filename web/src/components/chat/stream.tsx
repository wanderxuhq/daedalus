import { createSignal, createEffect } from 'solid-js';
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

export function StreamText(props: { text: () => string }) {
  const [html, setHtml] = createSignal('');

  createEffect(() => {
    setHtml(renderMarkdown(props.text()));
  });

  return <div class="msg-text markdown-body" innerHTML={html()} />;
}
