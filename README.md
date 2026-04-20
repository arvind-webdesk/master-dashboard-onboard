# Internal Onboarding Tool

Internal-only Next.js tool. Non-tech company staff fill a short form; the backend clones a company-owned dashboard template, creates a new private per-client GitHub repo, writes a `prisma/seed-data.json` with client config, commits, and pushes. The output is a GitHub repo URL.

**Phase 1 — no deployment.** Railway/Heroku automation comes later.

## Prerequisites

- Node.js 20+
- `git` on PATH (Windows: Git for Windows, macOS/Linux: system git)
- A GitHub OAuth App for staff sign-in
- A fine-grained GitHub PAT with `repo` + `admin:org` + `delete_repo` on the target org

## Setup

```bash
# 1. Install deps
npm install

# 2. Set up environment
cp .env.example .env.local
# Fill in GITHUB_TOKEN, GITHUB_ORG, GITHUB_CLIENT_ID/SECRET, NEXTAUTH_SECRET
# For TEMPLATE_REPO_URL see step 4 below.

# 3. Initialize the SQLite DB
npm run prisma:migrate

# 4. Create a local bare-repo fixture for dev (until the real template is ready)
npm run bootstrap:fixture
# This creates tmp/fixtures/template.git. Set:
#   TEMPLATE_REPO_URL="file:///<absolute-path>/tmp/fixtures/template.git"
# in .env.local.

# 5. Run the dev server
npm run dev
```

Open http://localhost:3000 and sign in with GitHub. Only members of `GITHUB_ORG` are allowed past the sign-in gate.

## How provisioning works

1. Staff open `/onboard`, fill the form (client name, admin email, modules, brand color, logo URL, notes), and click "Create Dashboard".
2. The server action inserts a `Client` row with status `PENDING` and a fresh `provisioningId` (idempotency key).
3. `ProvisioningService.create()` runs the pipeline:
   - `clone` → `git clone --depth=1 $TEMPLATE_REPO_URL tmp/prov-<shortId>`
   - `validate-template` → checks for `prisma/schema.prisma`, `prisma/seed.ts`, `README.md`
   - `write-seed` → writes `prisma/seed-data.json` with the client config
   - `git-reinit` → removes the template `.git`, re-initializes, commits
   - `create-repo` → `POST /orgs/<org>/repos` with `private: true`
   - `push` → `git push` using an `http.extraheader` bearer to avoid persisting the token
   - `finalize` → updates the `Client` row to `READY`, cleans up tmp
4. The form polls `/api/provision/:id/status` every 900 ms and renders friendly progress until terminal state.
5. On success, staff see a copyable GitHub URL. On failure, staff see a friendly error plus a reference ID for support.

## Template contract

The template repo MUST contain:

- `prisma/schema.prisma` — with `ClientConfig` and `ModuleEnablement` models (or similar)
- `prisma/seed.ts` — reads `prisma/seed-data.json` at deploy time and upserts the config
- `README.md` — client/dev-facing deploy instructions

The seed-data schema (v1) written by this tool:

```json
{
  "version": 1,
  "client": {
    "name": "Acme Corp",
    "slug": "acme-corp",
    "adminEmail": "admin@acme.com",
    "brandPrimaryColor": "#FF6600",
    "brandLogoUrl": null,
    "notes": "Q2 rollout"
  },
  "modules": [{ "key": "shopify", "enabled": true }],
  "provisionedAt": "2026-04-11T12:34:56Z",
  "provisionedBy": "alice-gh"
}
```

## Security notes

- `GITHUB_TOKEN` is read only inside `src/services/GitHubClient.ts` and never logged, never returned to the browser, never embedded in a git remote URL.
- All git operations run via `child_process.spawn('git', [argv...])` — never `shell: true`.
- Client slugs are validated against `^[a-z0-9-]{3,40}$` before being passed to git or the GitHub API.
- Secret patterns are scrubbed from git stdout/stderr before they reach the log, the DB, or the status poll stream.
- Run the `security-auditor` agent after any change to provisioning, auth, or the clients DB.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server on :3000 |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run prisma:migrate` | Apply Prisma migrations to dev SQLite DB |
| `npm run prisma:studio` | Prisma Studio UI on the dev DB |
| `npm run bootstrap:fixture` | Create a local bare-repo fixture at `tmp/fixtures/template.git` |
| `npm run provision:cli` | CLI version of the onboarding form (dev shortcut) |
