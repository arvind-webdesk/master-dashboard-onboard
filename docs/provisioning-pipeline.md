# Provisioning Pipeline Specification

> Reference document for `ProvisioningService.ts`, `onboarding-ui-builder`, and
> anyone modifying the end-to-end client-onboarding flow.
>
> The pipeline is **human-reviewed**: staff applies the config and previews the
> running dashboard in a browser BEFORE the GitHub repo is created. If the
> preview looks wrong, staff cancels — no orphan repo, no partial push.

## High-level flow

```
 ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
 │ A. Staff fills   │   │ B. Apply & gate  │   │ C. Live preview  │   │ D. Approve or    │
 │    form          │──▶│   (auto)         │──▶│   (staff in      │──▶│    cancel        │
 │                  │   │                  │   │    browser)      │   │                  │
 └──────────────────┘   └──────────────────┘   └──────────────────┘   └──────────────────┘
                                                                              │
                                                      ┌───────────────────────┴──────┐
                                                      ▼                              ▼
                                              ┌──────────────┐             ┌──────────────┐
                                              │ Approve:     │             │ Cancel:      │
                                              │ create repo  │             │ kill preview │
                                              │ + push       │             │ + wipe tmp   │
                                              │ + wipe tmp   │             │ (no GitHub)  │
                                              └──────────────┘             └──────────────┘
```

Key property: **GitHub repo is created only after staff clicks Approve.**
Everything before that lives in `./tmp/provisions/<sessionId>/` and is fully
rollbackable by deleting the tmp dir.

---

## Phase A — Form submission

`/onboard` collects:

| Field                | Zod validation                                        |
|----------------------|-------------------------------------------------------|
| Client name          | `z.string().min(2).max(80)`                           |
| Slug                 | `z.string().regex(/^[a-z0-9-]+$/).min(2).max(40)`     |
| Admin email          | `z.string().email()`                                  |
| Admin first name     | `z.string().min(1).max(40)`                           |
| Admin last name      | `z.string().min(1).max(40)`                           |
| Brand primary color  | `z.string().regex(/^#[0-9a-f]{6}$/i)`                 |
| Brand logo URL       | `z.string().url().optional()`                         |
| Notes                | `z.string().max(2000).optional()`                     |
| Enabled modules      | `z.array({ key, enabled }).min(1)` (≥1 enabled)       |

Staff clicks **"Apply & preview"** (not "Provision"). The button kicks off Phase B.

---

## Phase B — Apply + gate (automated, server-side)

Runs on the onboarding backend. Each provisioning session gets an isolated tmp
dir + preview port.

```
Stage 1 — Guard slug
  • Validate slug regex (again, server-side)
  • Check local clients DB          → 409 CONFLICT if exists
  • Check GitHub org for repo name  → 409 CONFLICT if exists
  • Create clients DB row           → status = 'preview-pending'

Stage 2 — Allocate session
  • Generate sessionId (nanoid)
  • Allocate tmp dir:  ./tmp/provisions/<sessionId>/
  • Allocate preview port from pool (e.g. 3001..3099)
  • Store session in an in-memory map:
      { sessionId, slug, tmpDir, port, childProcess, createdAt, expiresAt }
  • expiresAt = now + 30 minutes (absolute hard limit)

Stage 3 — Clone template (shallow)
  • git clone --depth=1 TEMPLATE_REPO_URL <tmpDir>
  • rm -rf <tmpDir>/.git          (we re-init after staff approves)

Stage 4 — Write seed-data.json
  • Serialize form data to v1 shape (see Contract section)
  • Write to <tmpDir>/seed-data.json

Stage 5 — pnpm install
  • cd <tmpDir> && pnpm install --prefer-offline

Stage 6 — pnpm apply:config
  • cd <tmpDir> && pnpm apply:config
    ├─ regenerates lib/client-config.ts
    ├─ patches app/globals.css (brand oklch block)
    ├─ writes docs/client-notes.md (if notes)
    ├─ runs pnpm drizzle-kit migrate
    └─ runs pnpm db:seed with SEED_EMAIL/SEED_FNAME/SEED_LNAME env overrides
  • Exit code must be 0. Any failure → mark session 'apply-failed', cleanup, return error.

Stage 7 — Typecheck gate (auto)
  • cd <tmpDir> && pnpm typecheck
  • Failure here = the template is broken for this input.
    → Do NOT start the preview. Return error to the form with the tsc output.
    → Mark session 'apply-failed', cleanup.
  • If it passes, continue to Phase C.
```

The typecheck gate is there so staff never sees a hydration/compile crash in
the preview — only working dashboards reach the human review step.

---

## Phase C — Live preview (human-reviewed)

```
Stage 8 — Start preview server
  • spawn('pnpm', ['dev', '-p', String(port)], { cwd: tmpDir })
  • Capture child's stdout/stderr (buffer up to 64 KB for debugging)
  • Wait for readiness:
      option A: HTTP GET http://localhost:<port>/login with 5s timeout,
                retry every 500ms for up to 60s
      option B: regex-match '/^\s*✓\s*Ready/m' in child stdout
    (Use option A — HTTP probe is the ground truth.)
  • If not ready in 60s: kill child, mark session 'preview-failed', cleanup, return error.

Stage 9 — Return preview URL
  • Respond to the form with:
      { sessionId, previewUrl: 'http://<host>:<port>', adminEmail, tempPassword, expiresAt }
  • Form transitions from 'applying' state to 'previewing' state.

Stage 10 — Staff reviews in browser
  • Staff clicks the previewUrl, signs in as the admin (form shows credentials).
  • Staff inspects:
      - Brand color on buttons / focus rings
      - Logo + client name in Sidebar
      - Sidebar hides disabled modules
      - Login / logout works
      - Each enabled module loads without errors
  • Staff returns to the onboarding form, which is still open in another tab.

Stage 11 — Staff action
  • Three buttons in the form (previewing state):
      [ Approve & create repo ]   → Phase D
      [ Cancel ]                   → Phase E
      [ Re-apply with changes ]    → kill current preview, go back to Phase A with the form pre-filled
```

### Preview lifecycle rules

- **Idle timeout**: 20 min since the preview started → auto-kill + cleanup.
- **Hard TTL**: 30 min total → auto-kill + cleanup regardless.
- **Graceful kill**: SIGTERM first, SIGKILL after 5s if still alive.
- **Port reclaim**: when a session ends, the port returns to the pool.
- **Crash detection**: if the child process exits unexpectedly, mark session
  'preview-crashed' and surface the last 100 lines of stderr to staff.

### Resource caps

- **Max concurrent previews per staff user**: 1 (next form submit cancels the prior preview).
- **Max concurrent previews globally**: 10 (pool is 3001–3099 = 99 ports, but pragmatic cap is 10 to keep RAM sane).
- **Max tmp dir size**: 2 GB per session (pnpm install + dev.db + .next cache). Enforced via a periodic `du -s` check; abort if exceeded.

---

## Phase D — Approve + push (staff clicked Approve)

```
Stage 12 — Stop the preview
  • Kill child process (SIGTERM, then SIGKILL).
  • Wait for exit; reclaim port.

Stage 13 — Clean ephemerals
  • rm <tmpDir>/dev.db  <tmpDir>/dev.db-{shm,wal,journal}  (DB is dev-only)
  • Do NOT rm node_modules or .next — they're already in .gitignore, they just
    won't be added in the next step.

Stage 14 — Commit
  • cd <tmpDir>
  • git init -b main
  • git config user.name  "WDS Onboarding"
  • git config user.email "onboarding@wds.internal"
  • git add .
  • git commit -m "Initial commit for <client.name> — provisioned by <staff email>"

Stage 15 — Create GitHub repo  ← only now
  • Octokit: POST /orgs/<GITHUB_ORG>/repos
      { name: "dashboard-<slug>", private: true, description: "Dashboard for <client.name>" }
  • Capture HTTPS clone URL from response.

Stage 16 — Push
  • git remote add origin <cloneUrl>
  • GIT_TERMINAL_PROMPT=0 git -c http.extraheader="Authorization: Bearer ${GITHUB_TOKEN}" push -u origin main
  • Rule: never embed the token in the remote URL — it leaves the token in .git/config.
    The tmp dir is about to be deleted, but belt + braces.

Stage 17 — Finalize
  • Update clients DB row: status='provisioned', repo_url=<htmlUrl>, provisioned_at=now()
  • Emit ClientProvisioned event
  • rm -rf <tmpDir>
  • Respond to form:
      { success: true, repoUrl: <htmlUrl>, adminEmail, tempPassword }
  • Form transitions to 'done' state and renders the success screen.
```

If Stage 16 (push) fails:
  1. Attempt auto-rollback: `DELETE /repos/<GITHUB_ORG>/dashboard-<slug>`
     (requires `delete_repo` scope on `GITHUB_TOKEN` — already in the env spec).
  2. If rollback fails too, log both errors + alert staff; DB row = 'failed-orphan'.

---

## Phase E — Cancel (staff clicked Cancel)

```
Stage 12' — Stop the preview
  • Kill child process.
Stage 13' — Cleanup
  • rm -rf <tmpDir>
  • Mark DB row 'cancelled'
  • Reclaim port
  • Respond to form: { cancelled: true }
```

No GitHub side effect, full reversibility.

---

## `seed-data.json` v1 contract

This is the **only** wire format between the onboarding tool and the dashboard
template. Both sides must agree on this shape. Extensions (new optional
fields) don't require a version bump; breaking changes require v2.

```ts
interface SeedDataV1 {
  version: 1
  client: {
    name:              string
    slug:              string
    adminEmail:        string
    adminFirstName:    string
    adminLastName:     string
    brandPrimaryColor: string          // #RRGGBB
    brandLogoUrl:      string | null
    notes:             string | null
  }
  modules: Array<{
    key:     string                    // one of: users, roles, email-templates,
                                       //         activity-logs, api-logs, settings, dashboard
    enabled: boolean
  }>
  provisionedAt: string                // ISO 8601
  provisionedBy: string                // staff email
}
```

Write with `JSON.stringify(data, null, 2)` for readable diffs.

---

## UI specification (`src/app/onboard/page.tsx`)

The form is a **state machine** with four states: `draft`, `applying`, `previewing`, `done`.

### draft

Normal form fields + a big primary button: **Apply & preview**.
Live slug auto-generation from the client name (with manual override).
Color picker + swatch. Logo URL preview (render as `<img>` on blur).
Module toggles: seven `Checkbox`es, at least one must be checked.

### applying (Stage 1–7)

Vertical stepper showing the pipeline progress:

```
⏳  Guarding slug...
✓  Allocating session             port 3015
✓  Cloning template               4.2s
✓  Writing seed data              0.1s
✓  Installing dependencies        18s
⏳  Applying config...
⏸  Typecheck
```

Icons: `⏳` running, `✓` done, `✗` failed, `⏸` pending.

If any stage fails, show the error inline (`✗ Applying config — failed`) and
a **Retry** button + **Cancel** button.

### previewing (Stage 8 onward, awaiting human input)

```
┌─────────────────────────────────────────────────────────────┐
│  Preview is ready                                           │
│                                                             │
│  ▶ Open preview  →  http://onboarding.wds.internal:3015     │
│                                                             │
│  Sign in with:                                              │
│    Email     admin@acme.com                                 │
│    Password  Admin@1234  (client must change on first login)│
│                                                             │
│  Session expires in 19:52                                   │
│                                                             │
│  What to check:                                             │
│    ☐  Brand color on login button                           │
│    ☐  Client name "Acme Corp" shown in sidebar              │
│    ☐  Logo appears in sidebar header                        │
│    ☐  Activity Logs is hidden (disabled in form)            │
│    ☐  Each enabled module loads without errors              │
│                                                             │
│  [ Approve & create repo ]  [ Re-apply ]  [ Cancel ]        │
└─────────────────────────────────────────────────────────────┘
```

- **Approve** → Phase D, polls status every 2s until `done`.
- **Re-apply** → kill preview, return to `draft` with form pre-filled (staff edits, clicks Apply again).
- **Cancel** → Phase E. Confirm dialog first ("This will discard the preview.").

### done

```
┌─────────────────────────────────────────────────────────────┐
│  ✓ Dashboard provisioned for Acme Corp                      │
│                                                             │
│  Repo         https://github.com/wds-org/dashboard-acme  📋 │
│  Admin login  admin@acme.com                             📋 │
│  Temp pass    Admin@1234 (client must change)            📋 │
│                                                             │
│  The dashboard is ready to deploy. Hand the repo URL and    │
│  credentials to the client or their hosting team.           │
│                                                             │
│  [ Provision another client ]  [ View clients list ]        │
└─────────────────────────────────────────────────────────────┘
```

Remove any mention of "run /apply-onboarding" — the skill stays only for
human devs working outside this pipeline.

---

## Server-side plumbing

### `src/services/ProvisioningService.ts`

```ts
import { spawn, ChildProcess } from 'node:child_process'
import { nanoid } from 'nanoid'

interface PreviewSession {
  sessionId:  string
  slug:       string
  tmpDir:     string
  port:       number
  child:      ChildProcess | null
  state:      'applying' | 'previewing' | 'approved' | 'cancelled' | 'failed'
  createdAt:  Date
  expiresAt:  Date
  stderrTail: string[]
}

const sessions = new Map<string, PreviewSession>()
const PORT_POOL = new PortPool(3001, 3099)
const IDLE_TIMEOUT_MS = 20 * 60_000
const HARD_TTL_MS     = 30 * 60_000

export class ProvisioningService {
  async applyAndPreview(form: OnboardingForm, staffEmail: string): Promise<PreviewSession>
  async approve(sessionId: string, staffEmail: string): Promise<{ repoUrl: string }>
  async cancel(sessionId: string): Promise<void>
  async reapply(sessionId: string, form: OnboardingForm): Promise<PreviewSession>
  // internal:
  private cleanupSession(sessionId: string): Promise<void>
  private async startPreview(session: PreviewSession): Promise<void>
  private async waitForReady(port: number): Promise<void>
}
```

### `src/app/api/provision/...` routes

| Method | Path                                     | Purpose                                  |
|--------|------------------------------------------|------------------------------------------|
| POST   | `/api/provision/apply`                   | Phase A–B–C (returns session + preview)  |
| POST   | `/api/provision/[sessionId]/approve`     | Phase D                                  |
| POST   | `/api/provision/[sessionId]/cancel`      | Phase E                                  |
| GET    | `/api/provision/[sessionId]/status`      | Polling endpoint for the UI stepper      |

All routes: staff auth check via NextAuth (`GITHUB_ORG` membership).

### Background cleanup worker

A simple `setInterval` loop runs every 60s:

```ts
setInterval(() => {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (s.expiresAt.getTime() < now || (now - s.createdAt.getTime()) > HARD_TTL_MS) {
      cleanupSession(id)
    }
  }
}, 60_000)
```

On server restart: `rm -rf ./tmp/provisions/*` to clean orphans. Any in-flight
sessions are lost (staff must restart) — acceptable because sessions are short.

---

## Command-injection safety

All subprocess calls use `spawn(cmd, [argv], options)` — **never** `shell: true`,
**never** string-interpolate the slug/name/email into a command. The slug is
regex-validated at Stage 1 and still passed only as an argv element.

```ts
// ✓ safe
spawn('git', ['init', '-b', 'main'], { cwd: tmp })
spawn('pnpm', ['dev', '-p', String(port)], { cwd: tmp })

// ✗ NEVER — CLAUDE.md rule
spawn(`git init -b main`, { cwd: tmp, shell: true })
```

## Token hygiene

- `GITHUB_TOKEN` is read ONLY inside `src/services/GitHubClient.ts`.
- Never log the token, never return it in any API response, never write it
  to `<tmpDir>/.env` (staff's client never sees WDS's token).
- Pushing uses `http.extraheader`, not a token-in-URL, so the token never
  lands in `<tmpDir>/.git/config`.

## Required env vars

Before starting the server, validate (fail fast with a clear staff-facing message):

- `GITHUB_TOKEN` — scopes: `repo`, `admin:org`, `delete_repo` on `GITHUB_ORG`
- `GITHUB_ORG` — non-empty
- `TEMPLATE_REPO_URL` — `https://github.com/...` or `file://...` (dev fixture)
- `DATABASE_URL` — onboarding tool's own clients DB (not the template's)
- `NEXTAUTH_SECRET`, `NEXTAUTH_URL`
- `ONBOARDING_HOST` — what URL staff's browser uses for the preview
  (e.g. `http://onboarding.wds.internal` — this is the host part of
  `previewUrl`; port is appended server-side)

## Local dev

For local testing, point at a bare-repo fixture:

```bash
# in master-dashboard-onboard
pnpm tsx scripts/bootstrap-fixture.ts       # creates ./tmp/fixtures/template.git

# .env.local
TEMPLATE_REPO_URL=file://D:/projects/master-dashboard-onboard/tmp/fixtures/template.git
ONBOARDING_HOST=http://localhost:3000
```

Then `pnpm dev`, open `/onboard`, fill the form, click **Apply & preview**,
open the preview URL (which opens on e.g. `localhost:3015`), click Approve,
and verify the local GitHub fixture received the push.
