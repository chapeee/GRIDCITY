import { defaultFilter } from 'cmdk';

export interface RankedEntry {
  /** What the search matches against (cmdk's `value`). */
  value: string;
  keywords?: string[];
}

export interface RankedSection<T extends RankedEntry> {
  key: string;
  entries: T[];
}

type Score = (value: string, search: string, keywords?: string[]) => number;

/**
 * Filters and orders the palette for a search: entries by score within each
 * section, and sections by their best entry, so Enter picks the best match
 * across the whole palette. cmdk 1.1 cannot reorder groups itself (it looks
 * them up by an internal id that never matches), which let any fuzzy host
 * match beat an exact action or resource ("settings", "session-cache").
 * Ties keep their original order. An empty search returns everything as is.
 */
export function rankSections<T extends RankedEntry, S extends RankedSection<T>>(
  sections: S[],
  search: string,
  score: Score = defaultFilter,
): S[] {
  const query = search.trim();
  if (!query) return sections;
  return sections
    .map((section, order) => {
      const entries = section.entries
        .map((entry, index) => ({ entry, index, score: score(entry.value, query, entry.keywords) }))
        .filter((scored) => scored.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index);
      return {
        section: { ...section, entries: entries.map((scored) => scored.entry) },
        best: entries[0]?.score ?? 0,
        order,
      };
    })
    .filter((ranked) => ranked.best > 0)
    .sort((a, b) => b.best - a.best || a.order - b.order)
    .map((ranked) => ranked.section);
}
