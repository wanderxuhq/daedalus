export function StreamText(props: { text: string }) {
  return <div class="msg-text" innerHTML={escapeHtml(props.text).replace(/\n/g, '<br>')} />;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
