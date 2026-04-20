---
name: e2e-test
description: Run Playwright end-to-end smoke tests against the onboarding tool. Use when the user says "run the tests", "test the app", "/e2e-test", "playwright", or before making any change to src/app/** or src/services/** that could break the form, the sign-in flow, or the clients list. This skill assumes a Playwright test scaffold already exists — if it does not, the skill refuses and tells the user to set it up first.
---

# E2E Test Skill — Playwright Smoke Tests

You are running Playwright smoke tests against the internal onboarding tool. The purpose is to catch regressions in `/signin`, `/onboard`, and `/clients` **before** a change reaches the one non-technical staff user who depends on this tool.

Tests are deliberately narrow — render, navigate, validate. They do not call GitHub, do not start real provisioning, and do not need a PAT. Deep pipeline coverage (clone → create-repo → push → invite) is explicitly out of scope and is covered by manual runs against the local fixture.

## When to run

Run the suite:
- **Before any commit** that touches `src/app/**`, `src/services/**`, or `src/lib/auth.ts`
- **After any change** to the onboarding wizard steps, the server action in `src/app/onboard/actions.ts`, or the `ProvisioningService` pipeline
- **Whenever the dev server starts misbehaving** — the tests are the fastest way to prove the routes still render
- **Before shipping a new module key** or changing the `ModuleSource` interface — the wizard chip rendering depends on it

Do not run:
- For typo fixes in comments or README
- For edits under `.claude/**`, `prisma/migrations/**`, or `docs/**`
- When the user asks you to just explain something

## How to run

```bash
# All specs, headless
npm run test:e2e

# Interactive debugger (opens the Playwright UI)
npm run test:e2e:ui

# A single spec by name
npm run test:e2e -- --grep signin
```

First time only, after `npm install`:

```bash
npm run test:e2e:install
```

This downloads the Chromium browser binary (~170 MB, one-time).

## Smoke-test philosophy

- Tests **MUST NOT** call `api.github.com`, `github.com`, or any git remote.
- Tests **MUST NOT** start real provisioning (no `ProvisioningService.create()`).
- Tests **MUST NOT** require a real `GITHUB_TOKEN` or `GITHUB_CLIENT_SECRET`.
- Tests **MUST** run in under 30 seconds total — anything slower means something is wrong.
- Each test spins up a fresh Playwright context, so there is no shared state between tests.

If you find yourself wanting to test the provisioning pipeline end-to-end, STOP. That belongs in a separate "full-pipeline" test file guarded by `E2E_HIT_GITHUB=1` (not yet scaffolded) or in a manual run against the local fixture template. Do not add pipeline assertions to the smoke suite.

## The auth bypass pattern

Every test that needs an authenticated session sets the env var:

```
E2E_BYPASS_AUTH=1
```

`src/lib/auth.ts` is expected to short-circuit when **BOTH**:
1. `process.env.E2E_BYPASS_AUTH === '1'`, AND
2. `process.env.NODE_ENV !== 'production'`

...and return a fake session with `user.login === 'e2e-user'`. The production guard is belt-and-suspenders — even if the env var is accidentally set on a deployed instance, the `NODE_ENV` check prevents bypass.

**This skill does NOT edit `auth.ts`.** If the bypass does not exist yet, refuse to run and tell the user: *"The `E2E_BYPASS_AUTH` hook in `src/lib/auth.ts` is missing. Add the `getBypassSession()` helper before running tests, or ask for a follow-up session to install the Playwright scaffold."*

## What the initial specs cover

When the scaffold exists, the suite contains three spec files and 10 tests total:

| Spec file | Test | What it asserts |
|---|---|---|
| `tests/e2e/signin.spec.ts` | `/signin renders when unauthenticated` | The "Continue with GitHub" button is visible when env vars are set |
| | `/signin shows the "not configured" banner when env is missing` | The amber setup banner appears when staff-auth env vars are unset |
| | `/signin error query param renders the matching message` | `/signin?error=AccessDenied` shows the right error copy |
| `tests/e2e/onboard.spec.ts` | `/onboard redirects to /signin when not authenticated` | No bypass → expect 302 to `/signin` |
| | `/onboard renders step 1 (Client) when authenticated` | Bypass → step 1 heading "Who is this dashboard for?" is visible |
| | `Next button is disabled when step 1 is invalid` | Empty Client name → Next is disabled; filling name + slug enables it |
| | `wizard navigates 5 steps forward and back without losing values` | Fill step 1–4, go back to step 1, assert the values are still there |
| | `Review step shows parsed team-member chips` | Typing `alice, bob, carol` into step 2 renders three `@alice`/`@bob`/`@carol` chips in the Review summary |
| `tests/e2e/clients.spec.ts` | `/clients renders the empty state when the DB has no rows` | No Client rows → "No clients have been provisioned yet" is visible |
| | `/clients redirects to /signin when not authenticated` | No bypass → expect 302 to `/signin` |

## Test-writing conventions

- **One spec per route.** Do not cram sign-in assertions into `onboard.spec.ts`.
- **Describe blocks named by user-story.** Example: `describe('when the staff user opens the onboard wizard', ...)`.
- **No shared state between specs.** Each test starts with a fresh `page` context.
- **Prefer `getByRole` and `getByText`** over CSS selectors. `page.getByRole('button', { name: 'Next' })` is more stable than `page.locator('.btn-primary')`.
- **Fill forms via user actions**, not by setting input values directly. Use `page.getByLabel('Client name').fill('Acme Corp')`.
- **Wait for network idle** when asserting on the dashboard list, not arbitrary timeouts.
- **Assert on visible text the staff user would see**, not on HTML structure.

## What NOT to test

- The GitHub API (`createInOrg`, `createForAuthenticatedUser`, `addCollaborator`) — stubbed out of scope.
- The git binary (`clone`, `push`, `init`) — never invoked in smoke tests.
- The Prisma DB internals — the tests trust that Prisma migrations work.
- Any real PAT behaviour — the bypass session has no token.
- NextAuth OAuth callback URLs — the bypass skips the whole flow.

If you catch yourself writing `page.route('**/api.github.com/**', ...)` for a smoke test, STOP. That means the test is trying to cover something that belongs in the pipeline test file, not here.

## Hard rules

- **Never include a literal GitHub token prefix** (`ghp_`, `github_pat_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) in any test file or test fixture. Use a sentinel like `'e2e-dummy-sentinel'` that does not match the regex in `.claude/hooks/protect-secrets.js`.
- **Never call production GitHub** from a test. If a test genuinely needs to intercept a GitHub call, use `page.route('**/api.github.com/**', route => route.fulfill({ status: 200, body: '{}' }))`.
- **Never disable the `protect-secrets` hook** to make a test pass. If the hook is rejecting your file, the file contains something it should not.
- **Never weaken the `E2E_BYPASS_AUTH` production guard.** The `NODE_ENV !== 'production'` check must remain.
- **Never commit `test-results/`, `playwright-report/`, or `playwright/.cache/`.** These belong in `.gitignore`.
- **Never add a test that takes longer than 10 seconds.** Smoke tests are fast by definition.

## If the scaffold is missing

Before running any command, verify these files exist:

- `package.json` lists `@playwright/test` as a devDependency
- `playwright.config.ts` at the project root
- `src/lib/auth.ts` contains a `getBypassSession()` helper (or equivalent)
- `tests/e2e/` directory with at least one `.spec.ts` file

If any of these is missing, **refuse to run the tests** and respond to the user with:

> *The Playwright scaffold is not installed yet. To run E2E tests, first install `@playwright/test@<pinned-version>`, add `playwright.config.ts`, wire `E2E_BYPASS_AUTH` into `src/lib/auth.ts`, and create the three spec files under `tests/e2e/`. That is a separate session — ask for "install the Playwright scaffold" when you are ready.*

Do not silently install Playwright. Do not create the spec files without explicit scope approval.

## Future CI note

Headless Playwright runs without a display, so adding a GitHub Actions job later is trivial — the smoke suite is already designed to run in a clean CI container without any interactive prompts. Track the eventual CI workflow as a separate ADR when the user is ready to enable it.
