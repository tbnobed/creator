---
name: Media proxy diagnosis
description: Distinguish API completion from delivery through the deployed web proxy and NPM.
---

Do not treat an API media request logged as completed as proof that the browser received the file. Inspect the upstream address in NPM errors to establish which service actually handles the next hop.

**Why:** Production logs showed completed API responses alongside browser partial transfers and NPM connection resets/refusals to the web port. The deployed route passed media through the web proxy, unlike the direct-to-API route described in the deployment guide. Web-container logs then confirmed repeated Node 24.21.0 crashes in Undici's Parser.finish with assert(!this.paused), not OOM kills.

**How to apply:** Check API, web-container, and NPM logs together. Ordinary “buffered to a temporary file” warnings do not establish disk or permission failures. Test interrupted transfers and process survival, not just successful status codes, when changing proxy streaming.

Use native HTTP/HTTPS streaming, not fetch, for this deployment's media proxy.

**Why:** Catching rejected fetch promises and stream errors did not stop the Undici assertion: it was thrown from an internal socket callback outside that error boundary. A pass-through proxy also must not silently decode compressed bytes while retaining wire headers.

**How to apply:** Preserve raw bytes, content encoding, ranges, and multiple cookies. Maintain backpressure and client-abort cleanup. Include concurrent slow-consumer tests with upstream socket closure; ordinary successful requests and small truncation tests alone missed the production failure.