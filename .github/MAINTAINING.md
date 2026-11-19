# Maintaining

## Plugin review bot

`.github/workflows/review.yml` runs `.github/scripts/main.ts` on every pull request. It labels the PR, keeps one comment explaining the result, and merges safe updates. The policy is in `.github/scripts/review.ts`.

A PR merges automatically only when it changes nothing but existing plugin files owned by its author, no plugin starts using a write or dangerous API, none uses a dangerous API at all, names, descriptions and IDs stay the same, and the Lua analyzer (`.github/scripts/lua.ts`) can follow all the code.

| Label | Meaning |
| --- | --- |
| `needs attention` | Unusual: new write/dangerous APIs, code the analyzer can't follow, a non-owner editing a plugin, changes outside `plugins/`, an invalid plugin, or the bot failed |
| `needs review` | Routine: new plugins, first-time contributors, plugins using dangerous APIs, name/description changes |
| `new plugin` | Adds a plugin |
| `size: small` / `medium` / `large` | Up to 40 / 200 / more lines of Lua in the changed plugins |
| `auto-merged` | Merged without a human; filter by it to audit |

**Ownership.** A plugin is owned by whoever filed the merged PR that added it. To transfer it or add co-owners, set `plugins.<id>.owners` in `marketplace.config.json`; it replaces the submitter. Collaborators with write access own every plugin.

**New GUI APIs.** Risk tiers for every `chameleon.*` function are in `.github/scripts/api.ts`. Add new GUI functions there, or plugins using them get `needs attention`.

**Repository settings.** Auto-merge needs squash merging enabled, and no branch protection rule requiring an approving review on the default branch.

**Security.** The workflow uses `pull_request_target` so it can label and merge fork PRs. It runs only base-branch code and reads PR files as data with git. Never add a step that installs, builds or runs anything from the PR.

**Development.** In `.github/scripts`: `npm ci`, `npm run typecheck`, `npm test` (Node 24).
