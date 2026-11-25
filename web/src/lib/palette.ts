// Command palette matching: pure, so it can be tested without a DOM.

export interface PaletteItem {
  id: string;
  group: string;
  label: string;
  /** Secondary text: a technical name, a pack, a kind. Also searched. */
  hint?: string;
  /** Extra words that should find this item (synonyms, old names). */
  keywords?: string;
}

/**
 * Score how well `query` matches `text`: higher is better, null is no match.
 * A prefix beats a word start beats a substring beats letters in order.
 */
export function matchScore(query: string, text: string, fuzzy = true): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 100 - Math.min(t.length - q.length, 50) / 10;
  const at = t.indexOf(q);
  if (at >= 0) {
    const wordStart = at === 0 || /[\s_\-/.&]/.test(t[at - 1] ?? "");
    return (wordStart ? 80 : 60) - at / 10;
  }
  if (!fuzzy) return null;
  // Letters in order (fuzzy), e.g. "gst" finds "gateway_status", but only
  // when they sit close together, so a short query does not match everything.
  let i = 0;
  let first = -1;
  let gaps = 0;
  let last = -1;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, i);
    if (found < 0) return null;
    if (first < 0) first = found;
    if (last >= 0 && found !== last + 1) gaps++;
    last = found;
    i = found + 1;
  }
  if (last - first + 1 > q.replace(/ /g, "").length * 3) return null;
  return Math.max(1, 40 - gaps * 5);
}

/** A hint or keyword counts only where a word starts with the query. */
function wordScore(query: string, text: string | undefined): number {
  if (!text) return -1;
  const s = matchScore(query, text, false);
  return s !== null && s >= 70 ? s : -1;
}

/** Filter and rank; with an empty query keep the given order. */
export function rankItems<T extends PaletteItem>(items: T[], query: string, limit = 50): T[] {
  if (!query.trim()) return items.slice(0, limit);
  const scored: Array<{ item: T; score: number; index: number }> = [];
  items.forEach((item, index) => {
    const best = Math.max(
      matchScore(query, item.label) ?? -1,
      wordScore(query, item.hint) - 10,
      wordScore(query, item.keywords) - 15,
    );
    if (best > 0) scored.push({ item, score: best, index });
  });
  // Letters-in-order matches only help when nothing contains the query outright:
  // "libr" should show Library, not every tool that happens to spell l-i-b-r.
  const strong = scored.some((s) => s.score >= 45);
  const kept = strong ? scored.filter((s) => s.score >= 45) : scored;
  kept.sort((a, b) => b.score - a.score || a.index - b.index);
  return kept.slice(0, limit).map((s) => s.item);
}
