import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({
  gfm: true,
  breaks: true,
});

export function StreamText(props: { text: string }) {
  const unsafeHtml = marked.parse(props.text) as string;
  const safeHtml = DOMPurify.sanitize(unsafeHtml, {
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'hr', 'ul', 'ol', 'li',
      'blockquote', 'pre', 'code', 'em', 'strong',
      'del', 'a', 'img', 'table', 'thead', 'tbody',
      'tr', 'th', 'td', 'div', 'span',
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class'],
  });
  // Wrap tables in a scrollable div
  const wrappedHtml = safeHtml.replace(/<table/g, '<div class="table-wrap"><table').replace(/<\/table>/g, '</table></div>');
  return <div class="msg-text markdown-body" innerHTML={wrappedHtml} />;
}
