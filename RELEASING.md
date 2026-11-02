# Releasing

Only this repository publishes to npm. The five packages (`@actuate/sdk`, `@actuate/runtime`, `@actuate/providers`, `@actuate/cli`, `create-actuate`) always share one version. Versions and changelogs come from [changesets](https://github.com/changesets/changesets): add one with `pnpm changeset` in any PR that changes a package.

**Publishing happens only when a release tag is pushed.** Merging to `main` never publishes.

## Releasing a version

1. **Bump the version** in a PR:

   ```bash
   git checkout main && git pull
   git checkout -b release-0.2.0
   pnpm changeset version     # applies pending changesets: new versions and CHANGELOGs
   pnpm check
   git commit -am "Release 0.2.0" && git push -u origin release-0.2.0
   ```

   Open the PR, review the CHANGELOGs, merge it.

2. **Tag the merge commit** on `main`:

   ```bash
   git checkout main && git pull
   git tag -a v0.2.0 -m "Release 0.2.0" && git push origin v0.2.0
   ```

3. **The `release` workflow publishes** (`.github/workflows/release.yml`). It:
   - refuses a tag that isn't on `main`;
   - runs `pnpm check`;
   - checks the tag matches every package's version;
   - publishes each version not yet on npm, in dependency order, with provenance, through trusted publishing (no npm token).

   A pre-release tag such as `v0.3.0-beta.1` is published under the `beta` npm tag, not `latest`.

4. **Check** from an empty folder: `npm create actuate demo`, then `cd demo && npm install && npx actuate dev`.

If the workflow fails partway, fix the cause and re-run it from the Actions tab: versions already on npm are skipped. To see what a release would do without publishing: `pnpm build && node scripts/publish.mjs v0.2.0 --dry-run`.

## One-time setup

- **npm:** the `actuate` organisation owns all five packages. On each package's npmjs.com page, under **Settings → Trusted publishing → GitHub Actions**:

  | Field | Value |
  | --- | --- |
  | Organization or user | `actuate-run` |
  | Repository | `actuate` |
  | Workflow filename | `release.yml` |
  | Environment name | `npm` |

  Allow `npm publish` only. Once a release has gone out this way, set each package's publishing access to "Require two-factor authentication and disallow tokens".
- **GitHub:** create the environment `npm` (Settings → Environments), optionally limited to tags matching `v*`.

## History

- **0.1.0** was published by hand from a laptop, because npm only allows trusted publishing for packages that already exist. Provenance starts with the first release from the workflow.
