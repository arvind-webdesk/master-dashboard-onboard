# Internal Onboarding Tool

Internal-only Next.js tool. Non-tech company staff open an onboarding form, enter a client's name and basic config, and the backend clones a company-owned dashboard template repo, creates a new per-client GitHub repo, writes a client-specific `.env`, and pushes. The output is a new GitHub repo URL that staff hand to the client (or an internal dev) for hosting.

**No deployment in Phase 1.** Railway/Heroku automation comes later.

## Two repos, one purpose

1. **`master-dashboard-onboard`** (this repo) — the internal onboarding tool. Form + provisioning service + clients DB. Lives on the company's own infra, gated behind staff auth. Not multi-tenant — it's a single-user admin tool.
2. **Template repo** (URL set via `TEMPLATE_REPO_URL`, provided by the user) — the actual dashboard app that gets cloned per client. This repo NEVER modifies the template.

Per provisioning:
- A new private GitHub repo named `dashboard-<client-slug>` is created under `GITHUB_ORG`
- The template's files are copied in as an initial commit
- A `.env` file is written with client-specific values read from the form
- The repo URL is returned to staff

## Tech stack
- **Frontend:** Next.js 15 (App Router), React, Tailwind, React Hook Form, Zod
- **Backend:** Next.js server actions, Prisma
- **Database:** SQLite for dev (zero-setup file DB). Postgres is a later migration target.
- **External APIs:** GitHub REST (Octokit), plus local `git` binary for clone/commit/push
- **Auth:** NextAuth v5 with GitHub OAuth. Gated by membership in `GITHUB_ORG`.

## Core non-negotiables
1. **No multi-tenant code** — each client gets their own separate GitHub repo. Do not write `tenantId` filters anywhere. The old multi-tenant PRD language does not apply.
2. **GitHub token hygiene** — `GITHUB_TOKEN` lives only in `GitHubClient.ts`. Never log it, never commit it, never return it to the browser, never write it into a client `.env`.
3. **Command injection safety** — `git` runs via `spawn(cmd, [argv])` with strict slug validation. Never `shell: true`. Never string-interpolate user input into git commands.
4. **Idempotent provisioning** — retrying a failed run must never create duplicate repos. The service checks both the local `clients` table and the GitHub org before creating anything.
5. **Template repo is read-only** — this tool clones from it, never pushes to it.
6. **Staff auth required** — every provisioning route checks session server-side.

## Agents & skills

Specialized agents in `.claude/agents/`:
- **onboarding-ui-builder** — builds the non-tech-friendly form at `/onboard` (shadcn/ui, server actions, progress streaming)
- **repo-provisioner** — owns `ProvisioningService.ts`, `GitHubClient.ts`, `TemplateCloner.ts`: clone → new repo → `.env` → commit → push → idempotent cleanup
- **security-auditor** — runs Opus, audits GitHub token handling, command injection, `.env` commit safety, staff auth, audit trail. Run proactively on any change to auth, provisioning, or the clients DB.

User-invocable skills in `.claude/skills/`:
- **/provision-client** — dev-console version of the form; collects inputs, confirms, delegates to the service, streams friendly progress

## Hooks
Wired in `.claude/settings.json`:
- **SessionStart** → `session-context.js` injects branch/env-status/reminders (shows which required env vars are set, without revealing values)
- **PreToolUse Write/Edit** → `protect-secrets.js` blocks `.env`/secrets paths and rejects hard-coded GitHub tokens, x-access-token URLs, bearer tokens, PEM headers, postgres URLs with passwords
- **PreToolUse Bash** → `block-dangerous-bash.js` blocks `rm -rf /`, `git push --force`, `git reset --hard`, any push to the template repo, `gh repo delete`, `cat .env`, curl-pipe-sh
- **PostToolUse Write/Edit** → `format-on-save.js` runs prettier + eslint --fix on TS/TSX/JS/CSS/MD files

## Required environment variables
Set locally in `.env.local` (gitignored). Never in code. Never committed.

| Name | Purpose |
|------|---------|
| `GITHUB_TOKEN` | Fine-grained PAT with `repo` + `admin:org` + `delete_repo` on `GITHUB_ORG`. Read only by `GitHubClient.ts`. `delete_repo` is required for rollback of failed provisioning. |
| `GITHUB_ORG` | The target GitHub organization where new client repos are created. |
| `GITHUB_CLIENT_ID` | GitHub OAuth App client ID (for staff sign-in via NextAuth). |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret. |
| `TEMPLATE_REPO_URL` | URL of the dashboard template repo to clone from (HTTPS or `file://` for dev fixtures). Not user-configurable. |
| `DATABASE_URL` | SQLite file URL for the onboarding tool's own `clients` + log tables (e.g. `file:./prisma/dev.db`). Never leaks into a client repo. |
| `NEXTAUTH_SECRET` / `NEXTAUTH_URL` | Staff auth for the onboarding form. |

## Client config strategy (locked)

Client-specific configuration (client name, admin email, brand color, enabled modules, notes) is **committed as a Prisma seed file** (`prisma/seed-data.json`) into the new cloned repo. The template's own `prisma/seed.ts` reads this file at the client's future deploy time and upserts rows into its `ClientConfig` + `ModuleEnablement` tables.

**The onboarding tool never writes a `.env` file into the cloned repo.** Runtime secrets (`DATABASE_URL`, `NEXTAUTH_SECRET`, per-module API keys) are the client's own responsibility to set at deploy time — that is documented in the template's README.

Contract for the template (enforced by the `validate-template` step):
- Must contain `prisma/schema.prisma`, `prisma/seed.ts`, and `README.md`
- `prisma/seed.ts` must read `prisma/seed-data.json` (version 1 schema below) and upsert `ClientConfig` + `ModuleEnablement` rows

Seed-data schema v1 — single source of truth between this tool and the template:

```json
{
  "version": 1,
  "client": { "name", "slug", "adminEmail", "brandPrimaryColor", "brandLogoUrl", "notes" },
  "modules": [{ "key": "shopify", "enabled": true }],
  "provisionedAt": "<ISO 8601>",
  "provisionedBy": "<github-login>"
}
```

## Workflow rules
- Before merging anything touching `src/services/**`, `src/app/onboard/**`, or the clients schema → run the **security-auditor** agent.
- Never run destructive git commands from a session (force push, reset --hard, gh repo delete) — hooks block most, but the rest require explicit user confirmation.
- Never push to the template repo. Template URL is config, not input, and clones are read-only.
- Never commit `.env*` files to THIS repo.
- Never embed `GITHUB_TOKEN` in a git remote URL. Use `-c http.extraheader` to pass the bearer header on the single push command, so the token never lands in `.git/config` inside the tmp dir.
- Git commands must run via `spawn('git', [argv...])` with a validated slug — never `shell: true`, never string-interpolate user input.

## Directory layout (target)
```
src/
  app/
    layout.tsx
    page.tsx                   # auth gate → /onboard or /signin
    (auth)/signin/page.tsx
    onboard/
      page.tsx                 # the form (non-tech staff UI)
      actions.ts               # server action → ProvisioningService
      _components/             # co-located form components
    api/
      auth/[...nextauth]/route.ts
      provision/[id]/status/route.ts
  services/
    ProvisioningService.ts     # the pipeline orchestrator
    GitHubClient.ts            # the only file that reads GITHUB_TOKEN
    TemplateCloner.ts          # spawn('git',...) clone, write seed, reinit
    events.ts                  # ClientProvisioned, ClientProvisioningFailed
  lib/
    env.ts                     # zod-validated runtime env for THIS tool
    slug.ts                    # normalize + validate
    scrub.ts                   # strip tokens from strings before logging
    prisma.ts                  # PrismaClient singleton
    auth.ts                    # NextAuth v5 config + org membership check
    module-source.ts           # ModuleSource interface
    modules.ts                 # StaticModuleSource (hard-coded list for MVP)
    preflight.ts               # boot-time checks (git binary, writable tmp/)
  components/ui/               # shadcn/ui primitives (added later)
prisma/
  schema.prisma                # Client, ProvisioningStepLog, AuditLog
scripts/
  provision.ts                 # CLI shortcut for /provision-client
  bootstrap-fixture.ts         # creates a local bare repo for dev/test
tmp/                           # per-provisioning temp clones (gitignored)
  fixtures/template.git/       # dev fixture bare repo
.claude/
  agents/
  skills/
  hooks/
  settings.json
```
