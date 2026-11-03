# @actuate/cli

## 0.1.2

### Patch Changes

- a678fbe: The runtime no longer lists Miniflare's internal `__miniflare_do_name` table under `/tables` in `actuate dev`, and it reads to the end any request body a route ignores, so workerd stops logging "Can't read from request stream after response has been sent". The CLI help now says MCP comes with deploying to Actuate.
- Updated dependencies [a678fbe]
  - @actuate/runtime@0.1.2
  - @actuate/sdk@0.1.2
  - @actuate/providers@0.1.2
  - create-actuate@0.1.2

## 0.1.1

### Patch Changes

- First release published from GitHub Actions, with npm provenance. No code changes since 0.1.0.
- Updated dependencies
  - @actuate/sdk@0.1.1
  - @actuate/runtime@0.1.1
  - @actuate/providers@0.1.1
  - create-actuate@0.1.1

## 0.1.0

### Minor Changes

- 62a1af6: First public release: the actuator SDK, the durable step engine for workerd, provider adapters, the `actuate` CLI and `npm create actuate`.

### Patch Changes

- Updated dependencies [62a1af6]
  - @actuate/sdk@0.1.0
  - @actuate/runtime@0.1.0
  - @actuate/providers@0.1.0
  - create-actuate@0.1.0
