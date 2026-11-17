export interface ObservationIdentity {
  id?: unknown;
  symbol?: unknown;
  date?: unknown;
  at?: unknown;
}

export function observationKey(card: ObservationIdentity): string | null {
  if (typeof card.symbol === 'string' && typeof card.date === 'string') return `${card.symbol}|${card.date}`;
  return typeof card.id === 'string' && card.id.length ? `id:${card.id}` : null;
}

/** Preserve the newest-first occurrence and collapse repeat cards for one symbol/session. */
export function uniqueObservationCards<T extends ObservationIdentity>(cards: readonly T[]): T[] {
  const seen = new Set<string>();
  return cards.filter((card, index) => {
    const key = observationKey(card) ?? `unkeyed:${index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Sort newest-first while preserving source order for cards with equal timestamps. */
export function sortObservationCards<T extends ObservationIdentity>(cards: readonly T[]): T[] {
  return cards.map((card, index) => ({ card, index })).sort((left, right) => {
    const leftAt = typeof left.card.at === 'number' && Number.isFinite(left.card.at) ? left.card.at : Number.NEGATIVE_INFINITY;
    const rightAt = typeof right.card.at === 'number' && Number.isFinite(right.card.at) ? right.card.at : Number.NEGATIVE_INFINITY;
    return rightAt - leftAt || left.index - right.index;
  }).map(({ card }) => card);
}

export interface ObservationPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  start: number;
  end: number;
}

/** Slice an already ordered card list, clamping the requested page to its bounds. */
export function paginateObservationCards<T>(cards: readonly T[], page: number, pageSize: number): ObservationPage<T> {
  const size = Number.isFinite(pageSize) && pageSize >= 1 ? Math.floor(pageSize) : 1;
  const total = cards.length;
  const totalPages = Math.ceil(total / size);
  const currentPage = totalPages === 0
    ? 1
    : Math.min(totalPages, Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1));
  const offset = (currentPage - 1) * size;
  const items = cards.slice(offset, offset + size);
  return {
    items,
    page: currentPage,
    pageSize: size,
    total,
    totalPages,
    start: total ? offset + 1 : 0,
    end: total ? offset + items.length : 0,
  };
}
