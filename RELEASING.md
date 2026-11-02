# Releasing

Only this repository publishes to npm. Versions and changelogs come from [changesets](https://github.com/changesets/changesets): add one with `pnpm changeset` in any PR that changes a package.

## First release (0.1.0), by hand

npm only lets you set up trusted publishing on a package that already exists, so the first release is published from a laptop. Provenance needs CI, so it starts with the second release.

1. npm: the organisation `actuate` exists, and you own `create-actuate` (claimed with a 0.0.1 placeholder, moved to the org or shared with it).
2. From a clean checkout of `main`:

   ```bash
   pnpm install --frozen-lockfile
   pnpm changeset version          # 0.0.0 -> 0.1.0 for all five, writes CHANGELOGs
   pnpm check                      # build, typecheck, test
   npm login                       # an account with publish rights on @actuate and create-actuate
   pnpm -r publish --access public --no-git-checks
   ```

   `pnpm -r publish` replaces `workspace:*` with `0.1.0` and publishes in dependency order. It asks for a one-time password per package if your npm account uses 2FA for publishing.
3. Commit the version bump and CHANGELOGs (`git checkout -b release-0.1.0`, commit, PR, merge) and tag it: `git tag v0.1.0 && git push origin v0.1.0`.
4. Check it from a clean folder: `npm create actuate demo`, `cd demo && npm install && npx actuate dev`.

## After the first release

1. For each package (`@actuate/sdk`, `@actuate/runtime`, `@actuate/providers`, `@actuate/cli`, `create-actuate`), set up **trusted publishing** on npmjs.com: GitHub Actions, repository `actuate-run/actuate`, workflow `release.yml`, environment `npm`. No npm token is ever created.
2. Add the release workflow below. From then on, releases publish from GitHub with provenance.

## Release workflow (add after the first release)

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
        env:
          NPM_CONFIG_PROVENANCE: "true" # provenance is CI-only, so it is set here rather than in publishConfig
        with:
          version: pnpm changeset version
          publish: pnpm -r publish --access public
```

The action opens a "Version packages" PR; merging it publishes.

## Before the first release

- `pnpm check` green.
- `cd packages/<name> && npm pack --dry-run` lists only `dist/`, `README.md`, `LICENSE`, `package.json`.
- Switch `link:` dependencies in `actuate-run/templates` and `actuate-run/platform` to `^0.1.0` once published, and drop `infra/scripts/link-actuate.sh` from the platform's Workers Builds commands.
