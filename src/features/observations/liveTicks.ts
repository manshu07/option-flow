export type LiveTickMap = Record<string, { ltp: number }>;

/** Accept only finite positive prices before placing streamed ticks in UI state. */
export function normalizeLiveTicks(value: unknown): LiveTickMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: LiveTickMap = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== 'object') continue;
    const ltp = (raw as { ltp?: unknown }).ltp;
    if (typeof ltp === 'number' && Number.isFinite(ltp) && ltp > 0) output[key] = { ltp };
  }
  return output;
}
