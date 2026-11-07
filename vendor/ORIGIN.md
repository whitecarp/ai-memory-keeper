# Shared core provenance

`core.js` is a byte-for-byte copy of this project's `app/public/core.js` (web app 0.2.1), copied read-only on 2026-11-04 and refreshed on 2026-11-06 after the web core gained Google Cloud Service Account JSON (`JSON 令牌`) OAuth2 Bearer token exchange on Agent Platform.

SHA-256: `3a531685657236446a09f7aa658edf1d437f49f1bf1b9c7eb93a16891238f830`

The CLI imports its prompt builders, chunking/grouping, merge prompts, Gemini transport, interaction text extraction and retry policy. It extends the response schema with ranked/dated evidence and the work profile; strict validation happens before any CLI memory commit because the web core's normalizer is intentionally permissive.

The copy makes the CLI directory self-contained. `vendor is the unchanged app core` tests byte identity against the adjacent app. If the web core changes, review and refresh this copy deliberately. No upstream licensing or attribution was removed from the copied file. No external package was introduced.
