import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { scrubAndTruncate } from '@/lib/scrub';
import { assertValidSlug, repoNameFromSlug } from '@/lib/slug';
import { assertKnownModules, defaultModuleSource } from '@/lib/modules';
import { runPreflight } from '@/lib/preflight';
import { GitHubClient, createGitHubClient } from './GitHubClient';
import { TemplateCloner, type SeedData } from './TemplateCloner';
import { events } from './events';
import {
  getPreviewSessionManager,
  getPortPool,
  type PreviewSession,
} from './PreviewSessionManager';

/**
 * The provisioning pipeline orchestrator.
 *
 * Every step is idempotent-aware: retrying a failed provision reuses the same
 * Client row (via provisioningId) and never creates duplicate GitHub repos
 * (slug-check is advisory; step `create-repo` is the real atomic lock via
 * GitHub's 422 "name already exists" response).
 *
 * Friendly errors are shown to staff. Technical errors are written to
 * ProvisioningStepLog only, never returned to the browser.
 *
 * === Two-phase flow ===
 * applyAndPreview() — Phases A-C: validate, clone, apply:config, typecheck,
 *                     spawn dev server. Returns a preview URL + sessionId.
 *                     NO GitHub side effects.
 * approve()         — Phase D: kill preview, commit, create repo, push.
 * cancel()          — Phase E: kill preview, rm -rf tmpDir, mark cancelled.
 * create()          — headless wrapper: applyAndPreview → approve immediately,
 *                     used by scripts/provision.ts.
 */

export interface ProvisionInput {
  provisioningId?: string; // omit for first attempt; pass back for retry

  // Step 1 — Client
  name: string;
  slug: string;
  industry?: string | null;
  country?: string | null;
  timezone: string;

  // Step 2 — Contact
  adminName: string;
  adminEmail: string;
  adminPhone?: string | null;
  /**
   * GitHub usernames to invite as collaborators on the new repo. Each entry
   * is invited as a `push` collaborator after the push step succeeds. The
   * invite for each user is soft-fail: a bad username produces a per-user
   * warning, the rest still get invited, and the provision is still marked
   * READY. Empty array means nobody is invited automatically.
   */
  teamGithubUsernames: string[];

  // Step 3 — Branding
  brandPrimaryColor: string;
  brandSecondaryColor?: string | null;
  brandLogoUrl?: string | null;
  brandFaviconUrl?: string | null;
  /** Sidebar palette preset. Defaults to 'navy'. */
  sidebarTheme: 'navy' | 'zoho' | 'slate' | 'neutral';

  // Step 4 — Dashboard type
  dashboardType: 'custom' | 'middleware' | 'saas';
  /**
   * Only honoured when dashboardType === 'middleware'. Secrets (access token,
   * webhook secret) are intentionally absent from this struct — the form
   * collects them, the service returns them in the action result for a
   * one-time handoff, and they are never persisted or committed.
   */
  integrations: {
    shopify: {
      enabled: boolean;
      storeUrl: string | null;
      sync: { products: boolean; orders: boolean; customers: boolean };
    };
    bigcommerce: {
      enabled: boolean;
      storeHash: string | null;
      sync: { products: boolean; orders: boolean; customers: boolean };
    };
  };

  // Step 5 — Features
  enabledModules: string[];
  planTier: 'starter' | 'pro' | 'enterprise';
  userSeats: number;
  goLiveDate?: string | null; // YYYY-MM-DD
  notes?: string | null;

  provisionedBy: string; // GitHub login of the staff user
}

export interface ApplyAndPreviewResult {
  sessionId: string;
  provisioningId: string;
  previewUrl: string;
  adminEmail: string;
  expiresAt: string; // ISO 8601
}

export interface ProvisionResult {
  clientId: string;
  provisioningId: string;
  status: 'READY' | 'FAILED';
  repoUrl?: string;
  friendlyError?: string;
  referenceId?: string;
  /** Soft-failure notes from steps that didn't trigger a rollback. */
  warnings?: string[];
}

type StepName =
  | 'validate'
  | 'slug-check'
  | 'create-client-row'
  | 'clone-template'
  | 'validate-template'
  | 'write-seed'
  | 'pnpm-install'
  | 'apply-config'
  | 'typecheck'
  | 'spawn-preview'
  | 'git-reinit'
  | 'create-repo'
  | 'push'
  | 'invite-collaborator'
  | 'finalize'
  | 'rollback';

function newShortId(): string {
  // 8 chars of base36 — Windows MAX_PATH friendly.
  return randomBytes(6).toString('base64url').slice(0, 8).toLowerCase();
}

function newReferenceId(): string {
  return randomBytes(4).toString('hex').toUpperCase();
}

export class ProvisioningService {
  private _github: GitHubClient | null = null;
  private _cloner: TemplateCloner | null = null;
  private readonly deps: { github?: GitHubClient; cloner?: TemplateCloner };

  constructor(deps?: { github?: GitHubClient; cloner?: TemplateCloner }) {
    // Lazy-init: GitHubClient reads GITHUB_TOKEN, TemplateCloner reads
    // TEMPLATE_REPO_URL. Constructing those eagerly would throw during module
    // load in pages that merely import this service (e.g. the onboard form),
    // which is bad UX for a tool where env may legitimately be incomplete
    // until the first provision attempt.
    this.deps = deps ?? {};
  }

  private get github(): GitHubClient {
    if (!this._github) this._github = this.deps.github ?? createGitHubClient();
    return this._github;
  }

  private get cloner(): TemplateCloner {
    if (!this._cloner) this._cloner = this.deps.cloner ?? new TemplateCloner();
    return this._cloner;
  }

  // ─── Phase A–C ──────────────────────────────────────────────────────────────

  /**
   * Runs Phases A–C: validate → clone → apply:config → typecheck → start
   * preview server. Returns a preview URL for staff to inspect.
   *
   * This is a long-running call (pnpm install + dev server cold start can take
   * 30–90s). The caller should run it in a background job or streaming context.
   *
   * NO GitHub side effects. The new repo is not created here.
   */
  async applyAndPreview(input: ProvisionInput): Promise<ApplyAndPreviewResult> {
    const pre = runPreflight();
    if (!pre.ok) {
      const missing = pre.checks.filter((c) => !c.ok).map((c) => c.name).join(', ');
      throw new Error(`[provisioning] preflight failed: ${missing}`);
    }

    const validated = await this.stepValidate(input);
    await this.stepSlugCheck(validated.slug);
    const { clientId, provisioningId, shortId } = await this.stepCreateClientRow(validated);

    // Allocate a preview port before we start the expensive steps, so if the
    // pool is exhausted we fail fast before cloning.
    const pool = getPortPool();
    let port: number;
    try {
      port = pool.acquire();
    } catch {
      throw new ProvisioningError(
        'All preview ports are currently in use. Please wait for an existing preview to expire (up to 30 minutes) or ask a colleague to cancel their open preview.',
        'port pool exhausted',
      );
    }

    // Start the cleanup worker (idempotent — won't double-start).
    const manager = getPreviewSessionManager();
    manager.startCleanupWorker(async (session) => {
      await this.cleanupSession(session, 'idle-timeout');
    });

    const workDir = this.cloner.workDirFor(shortId);

    const initialSeed = await this.buildSeed(validated);
    const session = manager.create({
      provisioningId,
      clientId,
      shortId,
      slug: validated.slug,
      tmpDir: workDir,
      port,
      seed: initialSeed,
      input: validated,
    });

    // Update DB row to reference this preview session.
    await prisma.client.update({
      where: { id: clientId },
      data: {
        status: 'PREVIEW_PENDING',
        previewSessionId: session.sessionId,
        previewStartedAt: new Date(),
      },
    });

    try {
      // Step — clone
      await this.runStep(clientId, 'clone-template', async () => {
        const result = await this.cloner.cloneTemplate(shortId);
        if (result.status !== 0) {
          console.error('[clone-template] failed:', result.stderr);
          const stderr = result.stderr.toLowerCase();
          let friendly = `Could not download the template: ${result.stderr.slice(0, 300)}`;
          if (/repository not found|404|does not exist/.test(stderr)) {
            friendly =
              'Template repo not found at TEMPLATE_REPO_URL. Either the URL is wrong, the repo is ' +
              'private and your PAT cannot read it, or the repo was deleted. Verify TEMPLATE_REPO_URL ' +
              'in .env.local and that your PAT has Contents:Read on it (private repos only).';
          } else if (
            /authentication failed|could not read username|terminal prompts disabled/.test(stderr)
          ) {
            friendly =
              'Template repo requires authentication and the PAT was not accepted. If the template ' +
              'repo is private, edit your PAT to add Contents:Read on the template repo. If it is ' +
              'public, the URL may be malformed.';
          } else if (/ssl|certificate/.test(stderr)) {
            friendly =
              'SSL certificate verification failed during clone. Your Git for Windows install may ' +
              'be missing CA certificates — reinstall Git for Windows and retry.';
          } else if (/could not resolve host|network|timeout/.test(stderr)) {
            friendly = 'Network error while cloning the template. Check your connection and retry.';
          }
          throw new ProvisioningError(friendly, result.stderr || 'git clone failed');
        }
        return { truncatedLog: result.stderr };
      });

      // Step — validate template shape
      await this.runStep(clientId, 'validate-template', async () => {
        const check = await this.cloner.validateTemplateShape(shortId);
        if (!check.ok) {
          console.error('[validate-template] missing files in clone:', check.missing.join(', '));
          throw new ProvisioningError(
            `The template at TEMPLATE_REPO_URL is missing required files: ${check.missing.join(', ')}. ` +
              'Either point TEMPLATE_REPO_URL at the correct repo, or run `npm run bootstrap:fixture` ' +
              'and use the printed file:// URL.',
            `missing: ${check.missing.join(', ')}`,
          );
        }
      });

      const seed = await this.buildSeed(validated);
      // Keep seed on session for debugging.
      session.seed = seed;

      // Step — write seed data
      await this.runStep(clientId, 'write-seed', async () => {
        await this.cloner.writeSeedData(shortId, seed);
      });

      // Step 7.5 — pnpm install
      await this.runStep(clientId, 'pnpm-install', async () => {
        const result = await this.cloner.runPnpmInstall(shortId);
        if (result.status !== 0) {
          console.error('[pnpm-install] failed:', result.stderr);
          throw new ProvisioningError(
            'Installing the template dependencies failed. This is usually a network issue or a ' +
              'lockfile conflict. Check the dev console for the full pnpm output.',
            result.stderr || 'pnpm install failed',
          );
        }
        return { truncatedLog: result.stderr };
      });

      // Step 7.6 — pnpm apply:config
      await this.runStep(clientId, 'apply-config', async () => {
        const adminParts = validated.adminName.trim().split(/\s+/);
        const fname = adminParts[0] ?? validated.adminName;
        const lname = adminParts.slice(1).join(' ') || fname;
        const result = await this.cloner.runApplyConfig(shortId, {
          seedEmail: validated.adminEmail,
          seedFname: fname,
          seedLname: lname,
        });
        if (result.status !== 0) {
          console.error('[apply-config] failed:', result.stderr);
          throw new ProvisioningError(
            'Applying the client configuration to the template failed. ' +
              'This usually means the seed-data.json is missing a required field or ' +
              'the template\'s apply:config script has a bug. Check the dev console for details.',
            result.stderr || 'pnpm apply:config failed',
          );
        }
        return { truncatedLog: result.stdout };
      });

      // Step 7.7 — typecheck gate
      await this.runStep(clientId, 'typecheck', async () => {
        const result = await this.cloner.runTypecheck(shortId);
        if (result.status !== 0) {
          console.error('[typecheck] failed:', result.stderr);
          throw new ProvisioningError(
            'Type-checking the configured template failed — the dashboard would not compile. ' +
              'This is likely a bug in the template\'s generated files. Contact the template ' +
              'maintainer with the reference below.',
            result.stdout + '\n' + result.stderr,
          );
        }
        return { truncatedLog: result.stdout };
      });

      // Step 7.8 — spawn preview dev server
      await this.runStep(clientId, 'spawn-preview', async () => {
        const { child, waitForReady } = await this.cloner.spawnDevServer(shortId, port);

        // Attach stderr ring buffer to the session.
        child.stderr?.on('data', (d: Buffer) => {
          const lines = d.toString('utf8').split('\n');
          session.stderrTail.push(...lines);
          if (session.stderrTail.length > 100) {
            session.stderrTail.splice(0, session.stderrTail.length - 100);
          }
        });

        // Handle unexpected crash before ready.
        const crashPromise = new Promise<never>((_, reject) => {
          child.once('exit', (code) => {
            if (code !== 0 && code !== null) {
              const tail = session.stderrTail.slice(-20).join('\n');
              reject(
                new ProvisioningError(
                  `The preview server crashed before becoming ready (exit ${code}). ` +
                    'This is usually a runtime error in the template code. Check the dev console for details.',
                  `dev server exited ${code}:\n${tail}`,
                ),
              );
            }
          });
        });

        try {
          await Promise.race([waitForReady(), crashPromise]);
        } catch (err) {
          await this.cloner.killPreviewChild(child);
          throw err;
        }

        session.child = child;
        session.state = 'previewing';

        return { truncatedLog: `preview ready at port ${port}` };
      });

      const previewUrl = `http://localhost:${port}`;

      return {
        sessionId: session.sessionId,
        provisioningId,
        previewUrl,
        adminEmail: validated.adminEmail,
        expiresAt: session.expiresAt.toISOString(),
      };
    } catch (err) {
      // Apply/preview phase failed — clean up session + tmpDir but NO GitHub.
      session.state = 'failed';
      manager.remove(session.sessionId);
      await this.cloner.killPreviewChild(session.child);
      await this.cloner.cleanup(shortId);
      pool.release(port);

      const friendly =
        err instanceof ProvisioningError
          ? err.friendlyMessage
          : 'Something went wrong while preparing the dashboard preview. Please try again.';
      const technical = err instanceof Error ? err.message : String(err);
      const referenceId = newReferenceId();

      const failureStep = await this.latestFailedStep(clientId);
      await prisma.client.update({
        where: { id: clientId },
        data: {
          status: 'FAILED',
          failureStep: failureStep ?? 'apply-preview',
          friendlyError: friendly,
          referenceId,
          previewSessionId: null,
        },
      });
      await prisma.auditLog.create({
        data: {
          actorLogin: validated.provisionedBy,
          action: 'CLIENT_PROVISIONING_FAILED',
          targetSlug: validated.slug,
          metadata: JSON.stringify({ step: failureStep, referenceId }),
        },
      });
      events.emit({
        type: 'ClientProvisioningFailed',
        clientId,
        slug: validated.slug,
        step: failureStep ?? 'apply-preview',
        referenceId,
        provisionedBy: validated.provisionedBy,
      });

      const error = new ProvisioningError(friendly, technical);
      (error as { referenceId?: string }).referenceId = referenceId;
      throw error;
    }
  }

  // ─── Phase D ─────────────────────────────────────────────────────────────────

  /**
   * Staff clicked Approve. Kills the preview, finalizes the git tree, then
   * creates the GitHub repo and pushes. Returns the public repo URL on success.
   */
  async approve(sessionId: string, actorLogin: string): Promise<ProvisionResult> {
    const manager = getPreviewSessionManager();
    const pool = getPortPool();
    const session = manager.get(sessionId);
    if (!session || session.state === 'done' || session.state === 'cancelled') {
      throw new ProvisioningError(
        'This preview session was not found or has already been closed. ' +
          'Please start a new Apply & preview.',
        `session not found: ${sessionId}`,
      );
    }

    session.state = 'approving';
    const { clientId, provisioningId, shortId, slug, tmpDir } = session;
    const validated = session.input;

    // Stage 12 — kill preview
    await this.cloner.killPreviewChild(session.child);
    session.child = null;
    pool.release(session.port);

    // Stage 13 — remove ephemeral SQLite dev DB
    await this.cloner.removeDevDb(shortId);

    const referenceId = newReferenceId();
    let createdRepo: { owner: string; name: string; fullName: string; htmlUrl: string; id: number } | null = null;
    const warnings: string[] = [];

    try {
      // Stage 14 — git init + stage + commit (fold apply:config-generated files)
      const commit = await this.runStep(clientId, 'git-reinit', async () => {
        // Re-init because the clone still has the template's .git.
        // reinitAndCommit removes .git, re-inits, stages everything, commits.
        const result = await this.cloner.reinitAndCommit(shortId, slug);
        if (!result.sha) {
          throw new ProvisioningError(
            'Could not prepare the initial commit. Please try again.',
            result.log.stderr || 'git init/add/commit failed',
          );
        }
        session.commitSha = result.sha;
        return { sha: result.sha, truncatedLog: result.log.stderr };
      });

      // Stage 15 — create GitHub repo
      const repoName = repoNameFromSlug(slug);
      const created = await this.runStep(clientId, 'create-repo', async () => {
        try {
          return await this.github.createPrivateRepo({
            name: repoName,
            description: `Dashboard for ${validated.name}`,
          });
        } catch (err) {
          const status = (err as { status?: number }).status;
          const message = err instanceof Error ? err.message : String(err);
          console.error('[create-repo] failed:', message);
          if (status === 422) {
            throw new ProvisioningError(
              `The repository name "${repoName}" is already in use. Please edit the slug and try again.`,
              '422 name already exists',
              { skipRepoDeletion: true },
            );
          }
          if (message.startsWith('[github]')) {
            throw new ProvisioningError(message, message, { skipRepoDeletion: true });
          }
          throw new ProvisioningError(
            `Could not create the GitHub repository: ${message}`,
            `github createInOrg failed: ${message}`,
            { skipRepoDeletion: true },
          );
        }
      });
      createdRepo = {
        owner: created!.owner,
        name: created!.name,
        fullName: created!.fullName,
        htmlUrl: created!.htmlUrl,
        id: created!.id,
      };
      console.log(`[create-repo] ok fullName=${created!.fullName} cloneUrl=${created!.cloneUrl}`);

      // Stage 16 — push
      await this.runStep(clientId, 'push', async () => {
        const pushResult = await this.cloner.push(shortId, created!.cloneUrl);
        console.log(
          `[push] exit=${pushResult.status} stderr=${pushResult.stderr.replace(/\n/g, ' ⏎ ')}`,
        );
        const refLanded = this.cloner.pushUpdatedARef(pushResult);
        const exitOk = pushResult.status === 0;
        if (exitOk && refLanded) {
          return { truncatedLog: pushResult.stderr };
        }
        const stderr = pushResult.stderr.toLowerCase();
        let friendly: string;
        if (exitOk && !refLanded) {
          friendly =
            'Push reported success but no commits were transferred. Check the dev console and verify the git-reinit step produced a commit.';
        } else if (
          /403|permission denied|write access|forbidden|authentication failed/.test(stderr)
        ) {
          friendly =
            'Push to GitHub was denied. The PAT can create the repo but cannot push to it. ' +
            'Use a classic PAT with the `repo` scope, or edit your fine-grained PAT to include ' +
            'Repository permission "Contents: Read and write". Then click Try again.';
        } else if (/could not resolve host|network|timeout/.test(stderr)) {
          friendly = 'Push failed because of a network problem. Check your connection and retry.';
        } else if (/src refspec main does not match any/.test(stderr)) {
          friendly =
            'Push failed because the local clone has no `main` branch. Your Git may be older than 2.28. Upgrade Git for Windows and retry.';
        } else {
          friendly = `The initial push failed: ${pushResult.stderr.slice(0, 300)}`;
        }
        console.error('[push] failed:', pushResult.stderr);
        throw new ProvisioningError(friendly, pushResult.stderr || 'git push reported no ref update', {
          pushUpdatedRef: refLanded,
        });
      });

      // Stage 16.5 — invite collaborators (soft-fail per user)
      for (const username of validated.teamGithubUsernames) {
        try {
          await this.runStep(clientId, 'invite-collaborator', async () => {
            const inviteResult = await this.github.addCollaborator({
              owner: createdRepo!.owner,
              repo: createdRepo!.name,
              username,
              permission: 'push',
            });
            console.log(`[invite-collaborator] ${inviteResult.status} user=${username}`);
          });
        } catch (err) {
          const status = (err as { status?: number }).status;
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[invite-collaborator] soft-fail user=${username}:`, message);
          let warning: string;
          if (status === 404) {
            warning = `Could not invite "${username}" — GitHub user not found. Verify the username and re-invite on GitHub manually.`;
          } else if (status === 422) {
            warning = `Could not invite "${username}" — GitHub rejected the username. Verify the username and re-invite manually.`;
          } else if (status === 403) {
            warning = `Could not invite "${username}" — your PAT cannot manage collaborators on this repo. Add the user manually on GitHub.`;
          } else if (message.startsWith('[github] Invalid GitHub username')) {
            warning = `Could not invite "${username}" — that is not a valid GitHub username. Re-invite manually if you meant a different name.`;
          } else {
            warning = `Could not invite "${username}" as a collaborator: ${message.slice(0, 200)}. Add the user manually on GitHub.`;
          }
          warnings.push(warning);
        }
      }

      // Stage 17 — finalize
      await this.runStep(clientId, 'finalize', async () => {
        await prisma.client.update({
          where: { id: clientId },
          data: {
            status: 'READY',
            githubRepoUrl: createdRepo!.htmlUrl,
            githubRepoId: String(createdRepo!.id),
            commitSha: (commit as { sha: string }).sha,
            failureStep: null,
            friendlyError: null,
            referenceId: null,
            warnings: warnings.length > 0 ? warnings.join('\n') : null,
            previewSessionId: null,
            previewStoppedAt: new Date(),
          },
        });
        await prisma.auditLog.create({
          data: {
            actorLogin,
            action: 'CLIENT_PREVIEW_APPROVED',
            targetSlug: slug,
            metadata: JSON.stringify({
              repo: createdRepo!.fullName,
              commitSha: (commit as { sha: string }).sha,
            }),
          },
        });
        events.emit({
          type: 'ClientProvisioned',
          clientId,
          slug,
          githubRepoUrl: createdRepo!.htmlUrl,
          commitSha: (commit as { sha: string }).sha,
          provisionedBy: actorLogin,
        });
      });

      await this.cloner.cleanup(shortId);
      session.state = 'done';
      manager.remove(sessionId);

      return {
        clientId,
        provisioningId,
        status: 'READY',
        repoUrl: createdRepo.htmlUrl,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (err) {
      const friendly =
        err instanceof ProvisioningError
          ? err.friendlyMessage
          : 'Something went wrong while creating the dashboard. Please try again or contact support.';
      const technical = err instanceof Error ? err.message : String(err);
      const opts = err instanceof ProvisioningError ? err.opts : {};

      session.state = 'failed';
      manager.remove(sessionId);

      await this.rollback(clientId, {
        shortId,
        slug,
        tmpDir,
        repoName: repoNameFromSlug(slug),
        createdRepo,
        friendlyMessage: friendly,
        technical,
        referenceId,
        actorLogin,
        skipRepoDeletion: opts.skipRepoDeletion === true,
        pushUpdatedRef: opts.pushUpdatedRef === true,
      });

      return {
        clientId,
        provisioningId,
        status: 'FAILED',
        friendlyError: friendly,
        referenceId,
      };
    }
  }

  // ─── Phase E ─────────────────────────────────────────────────────────────────

  /**
   * Staff clicked Cancel. Kills the preview, wipes the tmp dir.
   * No GitHub side effects.
   */
  async cancel(sessionId: string, actorLogin: string): Promise<void> {
    const manager = getPreviewSessionManager();
    const pool = getPortPool();
    const session = manager.get(sessionId);
    if (!session) return; // already gone — idempotent

    await this.cleanupSession(session, 'cancelled');
    pool.release(session.port);
    manager.remove(sessionId);

    await prisma.client.update({
      where: { id: session.clientId },
      data: {
        status: 'CANCELLED',
        previewSessionId: null,
        previewStoppedAt: new Date(),
      },
    });
    await prisma.auditLog.create({
      data: {
        actorLogin,
        action: 'CLIENT_PROVISIONING_CANCELLED',
        targetSlug: session.slug,
      },
    });
  }

  // ─── Headless wrapper ─────────────────────────────────────────────────────────

  /**
   * Convenience method for headless/CLI use (scripts/provision.ts).
   * Runs applyAndPreview immediately followed by approve — no human review gate.
   * Preserves the original one-step interface so CLI scripts are unchanged.
   */
  async create(input: ProvisionInput): Promise<ProvisionResult> {
    const pre = runPreflight();
    if (!pre.ok) {
      const missing = pre.checks.filter((c) => !c.ok).map((c) => c.name).join(', ');
      throw new Error(`[provisioning] preflight failed: ${missing}`);
    }

    let previewResult: ApplyAndPreviewResult;
    try {
      previewResult = await this.applyAndPreview(input);
    } catch (err) {
      // applyAndPreview already wrote the failure to DB — surface it here.
      const friendly =
        err instanceof ProvisioningError
          ? err.friendlyMessage
          : 'Apply phase failed unexpectedly.';
      const referenceId = (err as { referenceId?: string }).referenceId;
      // Look up clientId from DB via slug for the return shape.
      const row = await prisma.client.findUnique({ where: { slug: input.slug } });
      return {
        clientId: row?.id ?? '',
        provisioningId: row?.provisioningId ?? '',
        status: 'FAILED',
        friendlyError: friendly,
        referenceId,
      };
    }

    return this.approve(previewResult.sessionId, input.provisionedBy);
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private async buildSeed(validated: ProvisionInput): Promise<SeedData> {
    // Emit the FULL module list with explicit enabled flags (true for selected,
    // false otherwise). The template's apply:config needs an authoritative
    // state — if we only sent selected keys, modules not in the list would
    // keep the template's shipped default instead of being disabled.
    const allModules = await defaultModuleSource.list();
    const selected = new Set(validated.enabledModules);
    const modules = allModules.map((m) => ({ key: m.key, enabled: selected.has(m.key) }));

    return {
      version: 1,
      client: {
        name: validated.name,
        slug: validated.slug,
        industry: validated.industry ?? null,
        country: validated.country ?? null,
        timezone: validated.timezone,
      },
      contact: {
        adminName: validated.adminName,
        adminEmail: validated.adminEmail,
        adminPhone: validated.adminPhone ?? null,
      },
      branding: {
        primaryColor: validated.brandPrimaryColor,
        secondaryColor: validated.brandSecondaryColor ?? null,
        logoUrl: validated.brandLogoUrl ?? null,
        faviconUrl: validated.brandFaviconUrl ?? null,
        sidebarTheme: validated.sidebarTheme,
      },
      plan: {
        tier: validated.planTier,
        userSeats: validated.userSeats,
        goLiveDate: validated.goLiveDate ?? null,
      },
      modules,
      dashboardType: validated.dashboardType,
      integrations: {
        shopify: {
          enabled: validated.integrations.shopify.enabled,
          storeUrl: validated.integrations.shopify.storeUrl ?? null,
          sync: validated.integrations.shopify.sync,
        },
        bigcommerce: {
          enabled: validated.integrations.bigcommerce.enabled,
          storeHash: validated.integrations.bigcommerce.storeHash ?? null,
          sync: validated.integrations.bigcommerce.sync,
        },
      },
      notes: validated.notes ?? null,
      provisionedAt: new Date().toISOString(),
      provisionedBy: validated.provisionedBy,
    };
  }

  /** Kill child + rm tmpDir. Used by cancel and idle-timeout cleanup. */
  private async cleanupSession(
    session: PreviewSession,
    reason: string,
  ): Promise<void> {
    try {
      await this.cloner.killPreviewChild(session.child);
    } catch (err) {
      console.error(`[cleanup-session] kill failed (${reason}):`, (err as Error).message);
    }
    try {
      await this.cloner.cleanup(session.shortId);
    } catch (err) {
      console.error(`[cleanup-session] rm failed (${reason}):`, (err as Error).message);
    }
  }

  private async stepValidate(input: ProvisionInput): Promise<ProvisionInput> {
    assertValidSlug(input.slug);
    if (!/^#[0-9a-fA-F]{6}$/.test(input.brandPrimaryColor)) {
      throw new ProvisioningError(
        'Please pick a brand color before submitting.',
        'brandPrimaryColor not a #RRGGBB hex',
      );
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.adminEmail)) {
      throw new ProvisioningError(
        'Please enter a valid admin email address.',
        'adminEmail regex failed',
      );
    }
    if (input.enabledModules.length === 0) {
      throw new ProvisioningError(
        'Please select at least one module.',
        'empty enabledModules',
      );
    }
    await assertKnownModules(input.enabledModules);
    if (input.dashboardType === 'saas') {
      throw new ProvisioningError(
        'The SaaS dashboard is coming soon and cannot be provisioned yet.',
        'saas dashboardType not yet supported',
      );
    }
    if (input.dashboardType === 'middleware') {
      const { shopify, bigcommerce } = input.integrations;
      if (!shopify.enabled && !bigcommerce.enabled) {
        throw new ProvisioningError(
          'Middleware dashboards need at least one platform (Shopify or BigCommerce) enabled.',
          'middleware selected but no platform enabled',
        );
      }
      if (shopify.enabled && !shopify.storeUrl) {
        throw new ProvisioningError(
          'Please enter the Shopify store URL.',
          'shopify enabled but storeUrl missing',
        );
      }
      if (bigcommerce.enabled && !bigcommerce.storeHash) {
        throw new ProvisioningError(
          'Please enter the BigCommerce store hash.',
          'bigcommerce enabled but storeHash missing',
        );
      }
    }
    return input;
  }

  private async stepSlugCheck(slug: string): Promise<void> {
    const existing = await prisma.client.findUnique({ where: { slug } });
    if (existing && existing.status === 'READY') {
      throw new ProvisioningError(
        `A dashboard for "${slug}" already exists. Please edit the slug.`,
        'slug exists with status READY',
      );
    }
    const repoName = repoNameFromSlug(slug);
    if (await this.github.repoExists(repoName)) {
      throw new ProvisioningError(
        `A repository named "${repoName}" already exists in the GitHub organization. Please edit the slug.`,
        'github repoExists returned true',
      );
    }
  }

  private async stepCreateClientRow(input: ProvisionInput): Promise<{
    clientId: string;
    provisioningId: string;
    shortId: string;
  }> {
    const sharedFields = {
      industry: input.industry ?? null,
      country: input.country ?? null,
      timezone: input.timezone,
      adminName: input.adminName,
      adminEmail: input.adminEmail,
      adminPhone: input.adminPhone ?? null,
      teamGithubUsernames:
        input.teamGithubUsernames.length > 0 ? input.teamGithubUsernames.join(',') : null,
      brandPrimaryColor: input.brandPrimaryColor,
      brandSecondaryColor: input.brandSecondaryColor ?? null,
      brandLogoUrl: input.brandLogoUrl ?? null,
      brandFaviconUrl: input.brandFaviconUrl ?? null,
      enabledModules: input.enabledModules.join(','),
      planTier: input.planTier,
      userSeats: input.userSeats,
      goLiveDate: input.goLiveDate ? new Date(input.goLiveDate) : null,
      notes: input.notes ?? null,
      warnings: null,
    };

    if (input.provisioningId) {
      const existing = await prisma.client.findUnique({
        where: { provisioningId: input.provisioningId },
      });
      if (existing) {
        await prisma.client.update({
          where: { id: existing.id },
          data: {
            status: 'PENDING',
            failureStep: null,
            friendlyError: null,
            referenceId: null,
            previewSessionId: null,
            ...sharedFields,
          },
        });
        await prisma.auditLog.create({
          data: {
            actorLogin: input.provisionedBy,
            action: 'CLIENT_RETRIED',
            targetSlug: input.slug,
          },
        });
        return {
          clientId: existing.id,
          provisioningId: existing.provisioningId,
          shortId: newShortId(),
        };
      }
    }

    // Honour a client-generated provisioningId when provided. This lets the UI
    // start polling /api/provision/:id/status from the moment the form submits,
    // so step progress is visible while the server action is still running.
    // Validation: 32 hex chars (matches the legacy `randomBytes(16).toString('hex')`
    // shape + the route regex in /api/provision/[id]/status/route.ts).
    const provisioningId =
      input.provisioningId && /^[a-f0-9]{32}$/i.test(input.provisioningId)
        ? input.provisioningId
        : randomBytes(16).toString('hex');

    const client = await prisma.client.create({
      data: {
        provisioningId,
        slug: input.slug,
        name: input.name,
        status: 'PENDING',
        provisionedBy: input.provisionedBy,
        ...sharedFields,
      },
    });
    return { clientId: client.id, provisioningId, shortId: newShortId() };
  }

  private async runStep<T>(
    clientId: string,
    step: StepName,
    fn: () => Promise<T | void>,
  ): Promise<T | undefined> {
    const started = Date.now();
    const log = await prisma.provisioningStepLog.create({
      data: { clientId, step, status: 'STARTED' },
    });
    try {
      const result = await fn();
      await prisma.provisioningStepLog.update({
        where: { id: log.id },
        data: {
          status: 'OK',
          durationMs: Date.now() - started,
          finishedAt: new Date(),
          truncatedLog:
            result && typeof result === 'object' && 'truncatedLog' in (result as object)
              ? scrubAndTruncate(String((result as { truncatedLog?: string }).truncatedLog ?? ''))
              : null,
        },
      });
      return result as T | undefined;
    } catch (err) {
      await prisma.provisioningStepLog.update({
        where: { id: log.id },
        data: {
          status: 'FAILED',
          durationMs: Date.now() - started,
          finishedAt: new Date(),
          error: scrubAndTruncate(err instanceof Error ? err.message : String(err)),
        },
      });
      throw err;
    }
  }

  private async rollback(
    clientId: string,
    ctx: {
      shortId: string;
      slug: string;
      tmpDir: string;
      repoName: string;
      createdRepo: { fullName: string; htmlUrl: string; id: number } | null;
      friendlyMessage: string;
      technical: string;
      referenceId: string;
      actorLogin: string;
      skipRepoDeletion: boolean;
      pushUpdatedRef: boolean;
    },
  ): Promise<void> {
    await this.cloner.cleanup(ctx.shortId);

    if (ctx.createdRepo && !ctx.skipRepoDeletion) {
      let safeToDelete = false;
      if (ctx.pushUpdatedRef) {
        safeToDelete = false;
      } else {
        try {
          const hasCommits = await this.github.repoHasAnyCommits(ctx.repoName);
          safeToDelete = !hasCommits;
        } catch (err) {
          console.error('[rollback] failed to check repo state:', (err as Error).message);
          safeToDelete = false;
        }
      }
      if (safeToDelete) {
        try {
          await this.github.deleteRepo(ctx.repoName);
        } catch (err) {
          const status = (err as { status?: number }).status;
          const orphanUrl =
            ctx.createdRepo?.htmlUrl ??
            `https://github.com/${this.github.organization}/${ctx.repoName}`;
          const cleanupNote =
            status === 403
              ? ` Your PAT also lacks delete permission, so an empty repo was left behind: ${orphanUrl} — please delete it manually before retrying.`
              : ` An empty repo was created but could not be removed: ${orphanUrl} — please delete it manually before retrying.`;
          ctx.friendlyMessage = ctx.friendlyMessage + cleanupNote;
        }
      }
    }

    const failureStep = await this.latestFailedStep(clientId);

    await prisma.client.update({
      where: { id: clientId },
      data: {
        status: 'FAILED',
        failureStep: failureStep ?? 'rollback',
        friendlyError: ctx.friendlyMessage,
        referenceId: ctx.referenceId,
        previewSessionId: null,
        previewStoppedAt: new Date(),
      },
    });

    await prisma.auditLog.create({
      data: {
        actorLogin: ctx.actorLogin,
        action: 'CLIENT_PROVISIONING_FAILED',
        targetSlug: ctx.slug,
        metadata: JSON.stringify({
          step: failureStep,
          referenceId: ctx.referenceId,
        }),
      },
    });

    events.emit({
      type: 'ClientProvisioningFailed',
      clientId,
      slug: ctx.slug,
      step: failureStep ?? 'rollback',
      referenceId: ctx.referenceId,
      provisionedBy: ctx.actorLogin,
    });
  }

  private async latestFailedStep(clientId: string): Promise<string | null> {
    const row = await prisma.provisioningStepLog.findFirst({
      where: { clientId, status: 'FAILED' },
      orderBy: { startedAt: 'desc' },
    });
    return row?.step ?? null;
  }
}

/**
 * Internal error class carrying both a friendly message (safe for staff) and a
 * technical reason (for logs only).
 */
class ProvisioningError extends Error {
  readonly friendlyMessage: string;
  readonly opts: { skipRepoDeletion?: boolean; pushUpdatedRef?: boolean };
  constructor(
    friendlyMessage: string,
    technicalMessage: string,
    opts: { skipRepoDeletion?: boolean; pushUpdatedRef?: boolean } = {},
  ) {
    super(technicalMessage);
    this.friendlyMessage = friendlyMessage;
    this.opts = opts;
  }
}

/** Lightweight status lookup used by the polling API. */
export async function getProvisioningStatus(provisioningId: string) {
  const client = await prisma.client.findUnique({
    where: { provisioningId },
    include: {
      logs: { orderBy: { startedAt: 'asc' } },
    },
  });
  if (!client) return null;
  return {
    status: client.status,
    slug: client.slug,
    repoUrl: client.githubRepoUrl,
    friendlyError: client.friendlyError,
    referenceId: client.referenceId,
    warnings: client.warnings ? client.warnings.split('\n').filter(Boolean) : [],
    previewSessionId: client.previewSessionId,
    steps: client.logs.map((l) => ({
      step: l.step,
      status: l.status,
      startedAt: l.startedAt.toISOString(),
      finishedAt: l.finishedAt?.toISOString() ?? null,
      durationMs: l.durationMs,
      // Expose the scrubbed stderr + short-form log so the UI can surface
      // failure detail inline without requiring the operator to open the DB.
      error: l.error,
      truncatedLog: l.truncatedLog,
    })),
  };
}

/**
 * Look up a preview session's status for the polling API.
 * Returns null if the session is not found in the in-memory map.
 */
export function getPreviewSessionStatus(sessionId: string) {
  const session = getPreviewSessionManager().get(sessionId);
  if (!session) return null;
  return {
    state: session.state,
    previewUrl: `http://localhost:${session.port}`,
    expiresAt: session.expiresAt.toISOString(),
    slug: session.slug,
  };
}
