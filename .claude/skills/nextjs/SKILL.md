---
name: provision-client
description: Run the end-to-end client provisioning flow from a dev session — collect inputs, validate, clone the template repo, create a new per-client GitHub repo, write the .env, and push. This is the "developer shortcut" version of the onboarding form; the real UI is at /onboard for non-tech staff. No deployment in this phase — the output is a GitHub repo URL. Use when the user says "provision a new client", "create repo for <name>", or "test the provisioning flow".
---

# Provision Client Skill

You are running a client provisioning from a developer context — typically to test the flow or to provision a client when the UI is unavailable.

## Phase reminder
This is Phase 1: **clone template → new GitHub repo → push**. No Railway, no Heroku, no deploy. The output staff receives is a new GitHub repository URL.

## Step 1 — Preconditions
Verify before asking for any input:
- `process.env.GITHUB_TOKEN` is set
- `process.env.GITHUB_ORG` is set
- `process.env.TEMPLATE_REPO_URL` is set
- The `clients` table exists in the onboarding tool's DB
- `git` is available on PATH

If any precondition fails, stop and report — do not try to fix env vars by prompting the user for values.

## Step 2 — Collect inputs
Ask for (via AskUserQuestion if any are missing):

1. **Client name** (plain text, e.g. "Acme Corp")
2. **Admin email** (valid email, written into `prisma/seed-data.json`)
3. **Modules** — multi-select from the fixed module list below. Do NOT invent or aliases module keys — keys MUST come from `src/lib/modules.ts` so they match the template's `isAble` permission strings.
4. **Brand primary color** (hex)
5. **Logo URL** (optional)
6. **Notes** (optional, stored in the `clients` row)

### Available modules (keys match the template's sidebar `moduleKey` gates)

| Key               | Name                | Always-on? |
|-------------------|---------------------|------------|
| `dashboard`       | Dashboard           | Yes — not selectable; always emitted into `ENABLED_MODULES` by the template |
| `users`           | Users               | Optional |
| `roles`           | Roles & Permissions | Optional |
| `email-templates` | Email Templates     | Optional |
| `activity-logs`   | Activity Logs       | Optional |
| `api-logs`        | API Logs            | Optional |
| `settings`        | System Settings     | Optional |

If a user asks for a module not in this list, refuse and tell them to add it to `src/lib/modules.ts` and the template's navigation config first.

## Step 3 — Validate
- Normalize the client name to a slug matching `^[a-z0-9-]{3,40}$`
- Query the `clients` table to confirm the slug is unused
- Query GitHub (`GET /repos/<org>/dashboard-<slug>`) to confirm no collision
- Show the normalized config to the user and require explicit `yes` to continue

## Step 4 — Delegate
Call `ProvisioningService.create()` via `scripts/provision.ts`, OR hand off to the `repo-provisioner` agent. Do NOT implement git or GitHub API calls inline in this skill.

## Step 5 — Stream progress
Translate `ProvisioningStepLog` entries to friendly lines:
- "Cloning template…"
- "Verifying template shape…"
- "Writing client configuration (prisma/seed-data.json)…"
- "Preparing initial commit…"
- "Creating new GitHub repository…"
- "Pushing to GitHub…"
- "Repository ready!"

## Step 6 — Report
On success, output:
- Client slug
- GitHub repository URL (clickable)
- Initial commit SHA
- Summary of what was written to `.env` (key names only, values masked)
- Link to the `ProvisioningStepLog` entries
- Next step reminder: "This repo is not deployed anywhere yet. Hand the URL to the client (or internal dev) to set up hosting."

On failure, output:
- The step that failed
- The friendly error message
- The support reference ID
- Whether a partial GitHub repo was created and cleaned up
- Suggested remediation (re-run after fixing root cause — the service is idempotent)

## Hard rules
- **Never** paste or hard-code `GITHUB_TOKEN` into this skill or any command you run. It is always read from env by the service.
- **Never** skip the pre-provision confirmation.
- **Never** implement git/GitHub logic directly — delegate to `ProvisioningService` / `repo-provisioner` agent.
- **Never** retry a failed provision until you've confirmed whether a partial repo was created on GitHub.
- **Never** run against production `GITHUB_ORG` without the user typing the org name as confirmation.
