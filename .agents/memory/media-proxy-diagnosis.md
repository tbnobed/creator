---
name: Media proxy diagnosis
description: Distinguish API completion from delivery through the deployed web proxy and NPM.
---

Do not treat an API media request logged as completed as proof that the browser received the file. Inspect the upstream address in NPM errors to establish which service actually handles the next hop.

**Why:** Production logs showed completed API responses alongside browser partial transfers and NPM connection resets/refusals to the web port. The deployed route passed media through the web proxy, unlike the direct-to-API route described in the deployment guide. Local reproduction demonstrated that a truncated upstream response could crash the old web proxy; production process logs are still needed to attribute any particular outage to that cause.

**How to apply:** Check API, web-container, and NPM logs together. Ordinary “buffered to a temporary file” warnings do not establish disk or permission failures. Test interrupted transfers and process survival, not just successful status codes, when changing proxy streaming.