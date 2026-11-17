# Journal — archived-day outcomes

The journal pass (server/journal.mjs, wired into `build()`) resolves cards at
15:40 IST from the session's **raw** per-minute files
(`server/data/dhan/<date>/HHMM.json`). That timing is deliberate: the day is
still raw at 15:40, so the pass always runs before the archive step.

**Archived days are never read by the server.** One day's archive
(`server/data/archives/dhan/<date>.json.gz`) is ~120 MB compressed, ~395 MB of
JSON, and a multi-GB object tree once parsed. Resolving a full session through
it inside the API process OOMs the heap (observed 2026-11-17: 1.6 GB and
climbing at 139% CPU before the first pass was stopped).

If a day's journal pass never ran (server down at 15:40), back it up offline:

```bash
node --max-old-space-size=8192 scripts/backfillJournalArchive.mjs \
  2026-11-16 \
  server/data/archives/dhan/2026-11-16.json.gz \
  server/data/observations.json
```

The script decompresses the archive once, resolves every card of that date
with the same pure `resolveCard`, and writes outcomes atomically. Cards the
archive genuinely cannot settle stay `open` with their MFE/MAE — never guessed.

Why a card can legitimately resolve `open` with `mfe: 0`: many captured
minutes near the close carry a flat premium for a strike that stopped ticking;
if the premium never crossed the entry after the card was created, nothing
favourable was measured. That is the honest outcome of the captured data.