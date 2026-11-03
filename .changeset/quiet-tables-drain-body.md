---
"@actuate/runtime": patch
"@actuate/cli": patch
---

The runtime no longer lists Miniflare's internal `__miniflare_do_name` table under `/tables` in `actuate dev`, and it reads to the end any request body a route ignores, so workerd stops logging "Can't read from request stream after response has been sent". The CLI help now says MCP comes with deploying to Actuate.
