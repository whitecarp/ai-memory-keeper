# Shared core provenance

`core.js` is a byte-for-byte copy of this project's `app/public/core.js` (web app 0.2.1), copied read-only on 2026-11-04 and refreshed on 2026-11-05 after the web core gained the Google Cloud Agent Platform route (HTTP 402 fix).

SHA-256: `b2b9db176da226fe257b525e41853d61d3a02bfc2a815b0180dfa45914110d32`

The CLI imports its prompt builders, chunking/grouping, merge prompts, Gemini transport, interaction text extraction and retry policy. It extends the response schema with ranked/dated evidence and the work profile; strict validation happens before any CLI memory commit because the web core's normalizer is intentionally permissive.

The copy makes the CLI directory self-contained. `vendor is the unchanged app core` tests byte identity against the adjacent app. If the web core changes, review and refresh this copy deliberately. No upstream licensing or attribution was removed from the copied file. No external package was introduced.
