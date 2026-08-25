import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({
  gfm: true,
  breaks: true,
});

export function StreamText(props: { text: string }) {
  // Sanitize HTML to prevent XSS attacks
  const rawHtml = marked.parse(props.text) as string;
  const sanitizedHtml = DOMPurify.sanitize(rawHtml);
  return <div class="msg-text markdown-body" innerHTML={sanitizedHtml} />;
}
