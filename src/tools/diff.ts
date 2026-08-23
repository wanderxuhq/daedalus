/**
 * Minimal line-level unified diff for edit/write tool results.
 *
 * Not a patch engine — the output is for the terminal renderer (a diff card),
 * never for `patch` to apply. The hunk header is therefore only approximately
 * correct (it reports the changed region with its 2-line context, which is
 * exactly what a human diff view shows). The change region itself is precise:
 * unchanged lines, then `-` removals, then `+` additions.
 */
export function unifiedDiff(oldText: string, newText: string): string {
  // Strip trailing \r per line: the diff is UI-only (the terminal renderer), and
  // a CRLF file's \r would be written to the terminal mid-row, garbling the card.
  const a = oldText === '' ? [] : oldText.split('\n').map((l) => l.replace(/\r$/, ''));
  const b = newText === '' ? [] : newText.split('\n').map((l) => l.replace(/\r$/, ''));
  // Byte-identical? No diff at all.
  if (a.length === b.length && a.every((l, i) => l === b[i])) return '';

  // Trim the common prefix and suffix; only the middle changed.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) { aEnd--; bEnd--; }

  // Keep two context lines around the change so the card reads like `git diff`.
  const CTX = 2;
  const head = Math.max(0, start - CTX);
  const aTail = Math.min(a.length, aEnd + CTX);
  const bTail = Math.min(b.length, bEnd + CTX);

  const out: string[] = [];
  const aCount = aTail - head;
  const bCount = bTail - head;
  // Git-style hunk header: an empty side starts at line 0 (`-0,0` for a new
  // file, `+0,0` for a fully deleted one), matching `git diff`.
  const aStart = aCount === 0 ? 0 : head + 1;
  const bStart = bCount === 0 ? 0 : head + 1;
  out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
  // Context + removals from the old text…
  for (let i = head; i < aTail; i++) {
    out.push(i >= start && i < aEnd ? `-${a[i]}` : ` ${a[i]}`);
  }
  // …context + additions from the new text (context lines were already emitted).
  for (let i = head; i < bTail; i++) {
    if (i >= start && i < bEnd) out.push(`+${b[i]}`);
  }
  return out.join('\n');
}
