import { marked } from 'marked';

marked.setOptions({
  gfm: true,
  breaks: true,
});

export function StreamText(props: { text: string }) {
  return <div class="msg-text markdown-body" innerHTML={marked.parse(props.text) as string} />;
}
