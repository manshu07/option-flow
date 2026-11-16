export interface ObservationIdentity {
  id?: unknown;
  symbol?: unknown;
  date?: unknown;
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
