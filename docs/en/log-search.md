# Log full-text search — design study

**Date**: 2026-08-13 · **Status**: research (not implemented)

## 1. Current architecture

- `raw_log_events` stores **no searchable text**: only `tag_id`/`fmt_id`
  (dictionary pointers), the raw packet bytes, and metadata. The rendered
  `message` is computed **at read time** by
  `decodeEventsBatch` (packages/core/src/logging/decode.ts): dictionary
  lookup (cached per artifact) + printf-style format rendering per row.
- Read path: `findMany` (keyset) -> decode in batch -> JSON. There is no
  time-window on the UI; LogsView pages backwards indefinitely.
- Ingest path: broker stays intentionally light (`decodeState` is decided
  by artifact presence only; no format rendering happens at ingest).

## 2. Search semantics: substring, not token search

Device logs are short strings developers grep for. Token-based FTS is the
wrong primitive here:

- Typical queries: `0x0001`, `wifi`, `connection refused`, UUID fragments,
  Chinese words like `连接失败`. Substring semantics (`ILIKE '%q%'`)
  matches all of these; token-based search breaks on error codes, symbols,
  and mid-word fragments.
- Ranking is irrelevant (chronological order already carries the meaning).
- Typos/fuzzy matching are a nice-to-have, not a requirement.

Decision: **case-insensitive substring search** over decoded `tag` +
`message`, with device + optional time-window scoping.

## 3. Options

### A. Application-layer filter over the decoded window (V1 — recommended)

Filter decoded rows in the API (`message ILIKE` after `decodeEventsBatch`),
extending the existing keyset pager:

- Zero migration, zero new infra, works today.
- Cost: decoding N rows to return K matches. In practice queries are
  scoped to one device (the UI always has a device selected) and short
  text rows (~100 B), so scanning a few thousand rows costs low single
  digit ms. The keyset pager keeps walking backwards until a page fills,
  so paging cost is proportional to rows scanned, not matches found.
- Limitation: cross-device or unbounded-window searches are impractical
  (full decode scan). Mitigation: the UI search box is per-device (matches
  the current page model); a `from`/`to` filter can be added later to
  bound the scan, reusing the export window pattern.

### B. Materialized decoded text + trigram index (V2 — for cross-device search)

- Add `decoded_tag`/`decoded_message` text columns to `raw_log_events`,
  written at ingest (decode cost moves from read to write; dictionary
  cache makes it cheap), backfilled for old rows.
- `CREATE EXTENSION pg_trgm` +
  `GIN (decoded_message gin_trgm_ops)` index -> `ILIKE '%q%'` becomes
  index-assisted for ASCII queries >= 3 chars.
- Caveats: ~2x storage on the table (small absolute cost); CJK queries
  under 3 characters generate no trigrams and fall back to a scan
  (acceptable inside a device + time window); pg_trgm requires the
  extension in the managed Postgres image (Supabase/RDS/AWS include it,
  self-hosted needs CREATE EXTENSION privilege).

### C. External engine (Meilisearch/Typesense)

- Real tokenized search with CJK segmentation, fuzzy matching, facets.
- Costs: another container + traefik route + ingest double-write +
  consistency/replay concerns. Overkill for substring-grep semantics on
  this data volume; only revisit if fuzzy/ranked search becomes a
  requirement.

## 4. Recommendation

1. **V1 (this iteration)**: `q` parameter on the device log list endpoint;
   API decodes and filters in the page scan (option A). Frontend: a search
   field in LogsView that switches the query into search mode. Cheap,
   correct, consistent with the per-device UI.
2. **V2 (when cross-device search is asked for)**: materialize + trigram
   (option B), with a backfill job and a fallback to A for rows whose text
   was not yet materialized.

## 5. V1 implementation sketch

- API (`packages/api/src/api/logging.ts`):
  - validate `q` (string, max ~200 chars), reject `%`/`_`? no — escape
    them so they match literally (backslash escaping, `ESCAPE '\'`).
  - inner scan loop: fetch next keyset page (500 rows), decode, filter
    `tag/message` case-insensitively, accumulate until `limit` matches or
    no more rows; return matches + continuation cursor. Bound the total
    scan (e.g. 10k rows or 10 pages) and return `scan_exhausted: true` so
    the UI can tell "no matches in the scanned range".
- Escape rule: treat user input literally (`\` -> `\\`, `%` -> `\%`,
  `_` -> `\_`) — log content contains format strings with `%`.
- Tests: literal `%` matching, case-insensitivity, CJK substring,
  multi-page accumulation, scan bound, non-member 403 unchanged.
- Frontend: search input in the LogsView toolbar; a distinct "search
  results" mode with a clear button; keep streaming/infinite-scroll
  behavior identical (search results also page backwards).
