# Developer Guide

Read this before touching the code. `README.md` is the high-level overview — this doc covers the things that break, the workflows that aren't obvious, and the rules nobody likes finding out about the hard way.

## 1. First-time setup

Prerequisites: Node 20+, `git` on PATH, a GitHub OAuth App, and a fine-grained PAT with `repo` + `admin:org` + `delete_repo` on the target org.

```bash
npm install
cp .env.example .env.local
# Fill in GITHUB_TOKEN, GITHUB_ORG, GITHUB_CLIENT_ID/SECRET, NEXTAUTH_SECRET,
# NEXTAUTH_URL, DATABASE_URL="file:./dev.db", TEMPLATE_REPO_URL
npm run prisma:generate      # generates the Prisma client
npm run bootstrap:fixture    # creates tmp/fixtures/template.git for dev
npm run dev
```

Sign in at http://localhost:3000 with a GitHub account that is a member of `GITHUB_ORG`. Non-members are bounced at the auth gate — that is by design.

### Why `.env.local`, not `.env`

All Prisma scripts in `package.json` are wrapped in `dotenv -e .env.local --`. If you invoke `npx prisma <cmd>` directly, Prisma will only read `.env` and fail with `Environment variable not found: DATABASE_URL`. **Always go through `npm run prisma:*`**, or prefix your command with `dotenv -e .env.local --`.

## 2. The Windows Prisma gotcha (read this or lose an hour)

**Symptom:** you added a field to `prisma/schema.prisma`, your form now sends that field, and the server returns:

```
Unknown argument `yourNewField`. Available options are marked with ?.
```

**Cause:** the Prisma client in `node_modules/.prisma/client/` is stale. On Windows, the Next.js dev server holds `query_engine-windows.dll.node` open, so `prisma generate` fails with `EPERM ... rename ...tmp####`. The schema changed, but the client you're importing didn't.

**Fix — always in this order:**

1. Stop the dev server (Ctrl+C in the terminal running `npm run dev`).
2. `npm run prisma:generate` (or `npm run prisma:migrate` if you want a migration recorded).
3. If the column doesn't yet exist in `dev.db`: `dotenv -e .env.local -- npx prisma db push`.
4. Restart `npm run dev`.

The schema currently has no `prisma/migrations/` directory — history so far has been managed with `db push`. If you introduce `migrate dev`, commit the generated `prisma/migrations/` folder and update this section.

## 3. Schema-change workflow

Any change to `prisma/schema.prisma` follows the same path:

1. Edit `schema.prisma`. For non-destructive additions (new nullable column), add a `///` comment noting what replaced any deprecated field — see `clientGithubUsername` on the `Client` model for the pattern.
2. Stop the dev server.
3. `dotenv -e .env.local -- npx prisma db push` (dev) — or `npm run prisma:migrate` if you want a migration file.
4. Update anything in `src/services/**` that reads/writes the column.
5. Update the Zod schema in `src/app/onboard/**` if the field is user-visible.
6. Run the `security-auditor` agent (required whenever the `clients` schema changes — see CLAUDE.md).
7. Restart the dev server and smoke-test the form.

Never ship a schema change without regenerating the client. The stale-client error above is the #1 way this bites.

## 4. Non-negotiables (from CLAUDE.md, enforced by hooks)

These are blocked by hooks in `.claude/settings.json`, but they exist as rules first and blocks second. If a hook stops you, don't bypass it — fix the root cause.

- **`GITHUB_TOKEN` lives only in `src/services/GitHubClient.ts`.** Never log it, never return it to the browser, never write it into a client `.env`, never embed it in a git remote URL. For the one `git push`, pass it via `-c http.extraheader=...` so it never lands in `.git/config`.
- **Git commands run via `spawn('git', [argv...])`** — never `shell: true`, never string-interpolate user input. All slugs are validated against `^[a-z0-9-]{3,40}$` before they touch git or the GitHub API.
- **Provisioning is idempotent.** Before creating anything, check both the local `clients` table and the GitHub org for the slug. Retrying a failed run must not produce duplicate repos.
- **The template repo is read-only.** We clone from it. We never push to it. Pushes to the template URL are blocked by the `block-dangerous-bash.js` hook.
- **No multi-tenant logic.** Every client gets their own repo. Do not add `tenantId` filters anywhere.
- **Staff auth on every provisioning route.** Session checked server-side, GitHub org membership verified.
- **`.env*` files are never committed** to this repo, and `.env` files are never written into a cloned client repo. Client config flows via `prisma/seed-data.json` instead — see §5.

## 5. How provisioning actually works

`src/services/ProvisioningService.ts` is the orchestrator. Steps, in order:

| Step | What happens | Owner |
|---|---|---|
| `validate` | Zod-validate the form payload | server action |
| `slug-check` | Reject if slug exists in `clients` table OR in the GitHub org | `ProvisioningService` |
| `clone` | `git clone --depth=1 $TEMPLATE_REPO_URL tmp/prov-<shortId>` | `TemplateCloner` |
| `validate-template` | Verify `prisma/schema.prisma`, `prisma/seed.ts`, `README.md` exist | `TemplateCloner` |
| `write-seed` | Write `prisma/seed-data.json` (schema v1) | `TemplateCloner` |
| `git-reinit` | `rm -rf .git && git init && git add . && git commit` | `TemplateCloner` |
| `create-repo` | `POST /orgs/<org>/repos` with `private: true` | `GitHubClient` |
| `push` | `git push` with `-c http.extraheader` bearer | `TemplateCloner` |
| `finalize` | Mark `Client` row `READY`, cleanup tmp | `ProvisioningService` |
| `rollback` | On any failure: delete the remote repo if one was created, mark row `FAILED`, cleanup tmp | `ProvisioningService` |

Progress streams to the form via `GET /api/provision/:id/status` polled every ~900 ms. Terminal states: `READY` (URL shown) or `FAILED` (friendly error + reference ID, real error in `ProvisioningStepLog`).

The seed-data contract is the single source of truth between this tool and the template. If you change it, bump `version` and update the template's `prisma/seed.ts` in lockstep.

## 6. Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `Unknown argument` from Prisma | Stale client, dev server was running during generate | §2 |
| `Environment variable not found: DATABASE_URL` | Ran `npx prisma` directly instead of `npm run prisma:*` | §1 |
| `EPERM ... rename ...tmp####` on `prisma generate` | Dev server locked the query engine DLL | §2 |
| Provisioning fails at `clone` with `file://` template | Missing `tmp/fixtures/template.git` | `npm run bootstrap:fixture` |
| Auth gate bounces a real org member | GitHub OAuth App callback URL doesn't match `NEXTAUTH_URL` | Fix the OAuth App in GitHub settings |
| Form submits but nothing happens | Check the server terminal — Prisma / Zod errors print there, not in the browser |
| `push` fails with 403 | PAT missing `repo` scope or not authorized for the org | Regenerate PAT, authorize SSO |
| `create-repo` fails with 422 | Slug already exists in the org | `slug-check` should catch this; if it didn't, file a bug |

When in doubt, open Prisma Studio (`npm run prisma:studio`) and look at the latest `ProvisioningStepLog` row — `truncatedLog` and `error` have the scrubbed details.

## 7. Agents, skills, hooks

`.claude/` contains:

- **Agents** (`.claude/agents/`): `onboarding-ui-builder`, `repo-provisioner`, `security-auditor`. Invoke via the Agent tool when a task matches the description. `security-auditor` must be run after any change to auth, provisioning, or the clients schema.
- **Skills** (`.claude/skills/`): user-invokable `/nextjs` runs the full provisioning pipeline from a dev console, `/e2e-test` runs Playwright smoke tests.
- **Hooks** (`.claude/settings.json`):
  - `SessionStart` — prints a status banner (branch, env presence, provisioned client count).
  - `PreToolUse Write/Edit` → `protect-secrets.js` blocks writing to `.env*` and rejects hard-coded tokens.
  - `PreToolUse Bash` → `block-dangerous-bash.js` blocks `rm -rf /`, force-push, reset --hard, pushes to the template, `gh repo delete`, `cat .env`, `curl | sh`.
  - `PostToolUse Write/Edit` → `format-on-save.js` runs prettier + eslint --fix on changed files.

If a hook fires unexpectedly, read the message — it tells you which rule tripped. Don't disable hooks to make an error go away.

## 8. Before you merge

- `npm run typecheck` passes.
- `npm run lint` passes.
- You've run the `/e2e-test` skill against the fixture template.
- If you touched `src/services/**`, `src/app/onboard/**`, or `prisma/schema.prisma`: run the `security-auditor` agent.
- No `.env*` in the diff. No bare GitHub tokens. No `shell: true`. No new `tenantId` filters.
- For schema changes: either the migration file is committed, or you've noted in the PR that `db push` is the source of truth for this change.

## 9. Directory map (quick reference)

```
src/
  app/
    onboard/               # the form (non-tech staff UI)
      page.tsx
      actions.ts           # server action → ProvisioningService
      _components/
    api/
      auth/[...nextauth]/
      provision/[id]/status/
    (auth)/signin/
  services/
    ProvisioningService.ts # pipeline orchestrator
    GitHubClient.ts        # the ONLY file that reads GITHUB_TOKEN
    TemplateCloner.ts      # spawn('git',...) clone + reinit + push
    events.ts
  lib/
    env.ts                 # zod-validated runtime env
    slug.ts                # normalize + validate
    scrub.ts               # strip tokens from strings before logging
    prisma.ts              # PrismaClient singleton
    auth.ts                # NextAuth v5 + org membership check
prisma/
  schema.prisma            # Client, ProvisioningStepLog, AuditLog
  dev.db                   # SQLite (gitignored)
scripts/
  provision.ts             # CLI shortcut for /nextjs skill
  bootstrap-fixture.ts     # creates tmp/fixtures/template.git
tmp/                       # per-provisioning temp clones (gitignored)
  fixtures/template.git/   # dev fixture bare repo
.claude/
  agents/  skills/  hooks/  settings.json
```

## 10. Asking for help

- Check `ProvisioningStepLog` for the run that failed (`npm run prisma:studio`).
- Check the Next.js server terminal — server-action errors print there, not in the browser console.
- Look at the SessionStart banner printed at the top of any Claude session — it tells you which required env vars are missing without leaking values.
- For anything touching security, invoke the `security-auditor` agent before filing a PR.
