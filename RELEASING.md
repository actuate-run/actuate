# Releasing

Only this repository publishes to npm. Versions and changelogs come from [changesets](https://github.com/changesets/changesets): add one with `pnpm changeset` in any PR that changes a package.

## One-time setup (founder)

1. Create the npm organisation `actuate`.
2. For each package (`@actuate/sdk`, `@actuate/runtime`, `@actuate/providers`, `@actuate/cli`, `create-actuate`), set up **trusted publishing** on npmjs.com: GitHub Actions, repository `actuate-run/actuate`, workflow `release.yml`, environment `npm`. No npm token is ever created.
3. Add the release workflow below (deliberately not committed yet: no CI until launch).

## Release workflow (add at launch)

`.github/workflows/release.yml`:

```yaml
name: release
on:
  push:
    branches: [main]
permissions:
  contents: write
  pull-requests: write
  id-token: write # npm trusted publishing + provenance
jobs:
  release:
    runs-on: ubuntu-latest
    environment: npm
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm, registry-url: "https://registry.npmjs.org" }
      - run: pnpm install --frozen-lockfile
      - run: pnpm check
      - uses: changesets/action@v1
        with:
          version: pnpm changeset version
          publish: pnpm -r publish --access public
```

The action opens a "Version packages" PR; merging it publishes.

## Before the first release

- `pnpm check` green.
- `cd packages/<name> && npm pack --dry-run` lists only `dist/`, `README.md`, `LICENSE`, `package.json`.
- Switch `link:` dependencies in `actuate-run/templates` and `actuate-run/platform` to `^0.1.0` once published.
