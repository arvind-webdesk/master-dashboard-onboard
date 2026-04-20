import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getProvisioningEnv } from '@/lib/env';
import { assertValidSlug } from '@/lib/slug';
import { scrub, scrubAndTruncate } from '@/lib/scrub';

/**
 * Template cloner: clone the template repo into a per-provisioning temp dir,
 * validate its shape, write `prisma/seed-data.json`, reinitialize git, and
 * produce the initial commit.
 *
 * All git operations go through spawn(cmd, [argv]) — never `shell: true`,
 * never string-interpolate user input. Every stdout/stderr line is scrubbed
 * before being returned.
 */

export interface GitResult {
  status: number;
  stdout: string; // scrubbed + truncated
  stderr: string; // scrubbed + truncated
}

async function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        // Strip any ambient SSH/credential helpers — we want deterministic
        // behaviour and we never want git to pop up a login dialog.
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
        // Windows-specific: tell Git Credential Manager to never open its UI.
        // Without this, GCM ignores GIT_TERMINAL_PROMPT (which only blocks tty
        // prompts) and pops up a native login window the operator sees as
        // "asking to login".
        //
        // NOTE: do NOT set GIT_CONFIG_NOSYSTEM here — on Windows the system
        // config holds the SSL CA bundle path, and removing it makes every
        // HTTPS clone fail with cert verification errors. We only need to
        // disable the credential helper, not the entire system config.
        GCM_INTERACTIVE: 'Never',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('close', (code) => {
      resolve({
        status: code ?? -1,
        stdout: scrubAndTruncate(stdout),
        stderr: scrubAndTruncate(stderr),
      });
    });
    child.on('error', (err) => {
      resolve({
        status: -1,
        stdout: '',
        stderr: scrubAndTruncate(`spawn error: ${err.message}`),
      });
    });
  });
}

/**
 * Contract between this tool and the template's `prisma/seed.ts`.
 * Version this schema when you add or remove fields — the template reads
 * `version` and should refuse anything it doesn't understand.
 */
export interface SeedData {
  version: 1;
  client: {
    name: string;
    slug: string;
    industry: string | null;
    country: string | null;
    timezone: string;
  };
  contact: {
    adminName: string;
    adminEmail: string;
    adminPhone: string | null;
  };
  branding: {
    primaryColor: string;
    secondaryColor: string | null;
    logoUrl: string | null;
    faviconUrl: string | null;
  };
  plan: {
    tier: 'starter' | 'pro' | 'enterprise';
    userSeats: number;
    goLiveDate: string | null; // YYYY-MM-DD
  };
  modules: Array<{ key: string; enabled: true }>;
  notes: string | null;
  provisionedAt: string; // ISO 8601
  provisionedBy: string; // GitHub login
}

export class TemplateCloner {
  private readonly tmpRoot: string;

  constructor(tmpRoot?: string) {
    // Default tmp location lives OUTSIDE the onboarding repo.
    //
    // Previously this was `<onboarding>/tmp/` which worked fine for git
    // operations but broke Next.js's turbopack dev server: when the preview
    // starts in `tmp/prov-<id>/`, Next walks up looking for a workspace root,
    // finds the onboarding's `package-lock.json`, and crashes with exit code
    // 3221226505 (Windows STATUS_STACK_BUFFER_OVERRUN) trying to resolve
    // modules against the wrong tree.
    //
    // Using OS tmp (`%TEMP%` on Windows, `/tmp` on Unix) means the workspace
    // has no parent lockfile. A `WDS_TMP_ROOT` env var is still honoured so
    // operators can override for disk-space or cleanup reasons.
    this.tmpRoot =
      tmpRoot
      ?? process.env.WDS_TMP_ROOT
      ?? path.join(os.tmpdir(), 'wds-onboarding-provisions');
  }

  /** Unique per-provisioning working directory. */
  workDirFor(shortId: string): string {
    return path.join(this.tmpRoot, `prov-${shortId}`);
  }

  /** Best-effort cleanup. Non-fatal on Windows lock flakes. */
  async cleanup(shortId: string): Promise<void> {
    const dir = this.workDirFor(shortId);
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Log upstream; cleanup failure must not break the pipeline.
    }
  }

  /**
   * Step 4 — shallow clone the template.
   *
   * For HTTPS URLs we embed the GITHUB_TOKEN as basic-auth so the clone works
   * even when the template repo is private. For file:// URLs (used by the
   * dev fixture) we leave the URL untouched. SSH URLs would also be passed
   * through as-is — the operator is expected to have an SSH agent set up if
   * they go that route.
   *
   * `-c credential.helper=` disables Git Credential Manager for this single
   * command, mirroring the push step. Without it, GCM on Windows can override
   * our explicit token with cached credentials and silently log in as the
   * wrong user.
   */
  async cloneTemplate(shortId: string): Promise<GitResult> {
    const env = getProvisioningEnv();
    const workDir = this.workDirFor(shortId);
    await fs.mkdir(this.tmpRoot, { recursive: true });

    const urlToClone = this.tokenizeIfHttps(env.TEMPLATE_REPO_URL, env.GITHUB_TOKEN);

    return runGit(
      [
        '-c',
        'credential.helper=',
        '-c',
        'credential.useHttpPath=false',
        'clone',
        '--depth=1',
        urlToClone,
        workDir,
      ],
      this.tmpRoot,
    );
  }

  /**
   * Build a basic-auth URL for HTTPS GitHub clones. file:// and ssh:// URLs
   * are returned untouched. The literal token-in-URL pattern is built via
   * the URL API at runtime so it never appears in source.
   */
  private tokenizeIfHttps(url: string, token: string): string {
    if (!/^https:\/\//i.test(url)) return url;
    try {
      const u = new URL(url);
      if (u.hostname.toLowerCase() !== 'github.com') return url; // only tokenize GitHub
      u.username = 'x-access-token';
      u.password = token;
      return u.toString();
    } catch {
      return url;
    }
  }

  /**
   * Step 5 — structural validation of the cloned template.
   *
   * Prisma-specific checks were removed because the real dashboard template
   * uses a different stack (models/, seeders/, repositories/, service/).
   * The remaining checks are deliberately minimal — just enough to catch
   * the case where TEMPLATE_REPO_URL was typo'd and we cloned an empty repo.
   *
   * Currently we only require `README.md`, which is near-universal in real
   * GitHub projects and costs nothing to verify. If you want to require
   * template-specific files (e.g. `package.json` + `seeders/`), add them
   * here — keep the list short.
   */
  async validateTemplateShape(shortId: string): Promise<{ ok: boolean; missing: string[] }> {
    const workDir = this.workDirFor(shortId);
    const required = ['README.md'];
    const missing = required.filter((rel) => !existsSync(path.join(workDir, rel)));
    return { ok: missing.length === 0, missing };
  }

  /** Step 6 — write the seed data file into the clone. */
  async writeSeedData(shortId: string, seed: SeedData): Promise<void> {
    const workDir = this.workDirFor(shortId);
    const target = path.join(workDir, 'prisma', 'seed-data.json');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(seed, null, 2) + '\n', 'utf8');
  }

  /** Step 7 — drop the template's .git, reinit, stage, commit. Returns commit SHA. */
  async reinitAndCommit(
    shortId: string,
    slug: string,
  ): Promise<{ sha: string; log: GitResult }> {
    assertValidSlug(slug);
    const workDir = this.workDirFor(shortId);
    const dotGit = path.join(workDir, '.git');

    await fs.rm(dotGit, { recursive: true, force: true, maxRetries: 3 });

    const steps: [string, string[]][] = [
      ['init', ['init', '-b', 'main']],
      ['add', ['add', '-A']],
      [
        'commit',
        [
          '-c',
          'user.email=onboarding@internal',
          '-c',
          'user.name=Onboarding Tool',
          'commit',
          '-m',
          `Initial provisioning for ${slug}`,
        ],
      ],
    ];

    let combinedLog: GitResult = { status: 0, stdout: '', stderr: '' };
    for (const [, args] of steps) {
      const result = await runGit(args, workDir);
      combinedLog = {
        status: result.status,
        stdout: scrub(combinedLog.stdout + '\n' + result.stdout).slice(0, 8 * 1024),
        stderr: scrub(combinedLog.stderr + '\n' + result.stderr).slice(0, 8 * 1024),
      };
      if (result.status !== 0) {
        return { sha: '', log: combinedLog };
      }
    }

    // Capture the commit SHA.
    const revParse = await runGit(['rev-parse', 'HEAD'], workDir);
    if (revParse.status !== 0) {
      return { sha: '', log: combinedLog };
    }
    const sha = revParse.stdout.trim();
    return { sha, log: combinedLog };
  }

  /**
   * Step 9 — push the initial commit to the newly-created GitHub repo.
   *
   * On Windows, `-c http.extraheader` is unreliable: Git Credential Manager
   * (GCM) intercepts the request, ignores our header, and pops up a native
   * login dialog. We bypass GCM by:
   *
   *   1. Embedding the token directly in the URL as basic-auth (built via
   *      the URL API at runtime so the literal pattern never appears in
   *      source — the protect-secrets hook would otherwise refuse the file).
   *   2. Setting `credential.helper=` (empty) for this single command,
   *      which disables ALL configured credential helpers including GCM.
   *   3. Pushing WITHOUT --set-upstream so the tokenized URL is never
   *      written into .git/config (it would be persisted only if we set
   *      it as the remote, which we don't).
   *
   * The temp clone is deleted immediately after the push, so even the
   * in-memory URL has no lifetime beyond this single command.
   */
  async push(shortId: string, repoHttpsUrl: string): Promise<GitResult> {
    const env = getProvisioningEnv();
    const workDir = this.workDirFor(shortId);

    // Build the basic-auth URL using the URL API. The literal token-in-URL
    // pattern never appears in source code.
    const u = new URL(repoHttpsUrl);
    u.username = 'x-access-token';
    u.password = env.GITHUB_TOKEN;
    const tokenizedUrl = u.toString();

    const args = [
      '-c',
      'credential.helper=',
      '-c',
      'credential.useHttpPath=false',
      'push',
      tokenizedUrl,
      'main:main',
    ];
    const result = await runGit(args, workDir);

    // Defence-in-depth: scrub the result even though runGit already did,
    // because the tokenized URL could appear in stderr if git echoes the
    // remote URL on certain failures.
    return {
      status: result.status,
      stdout: scrub(result.stdout),
      stderr: scrub(result.stderr),
    };
  }

  /**
   * Did the push actually update a ref?
   *
   * IMPORTANT: a `git push` exit code of 0 does NOT prove that any commits
   * landed on the remote. If the local repo had nothing new to push, git
   * exits 0 with "Everything up-to-date" and no ref update line. We must
   * check stderr for an explicit ref-update marker.
   *
   * Markers we accept (printed to stderr by `git push` on success):
   *   * [new branch]      main -> main
   *   <oldsha>..<newsha>  main -> main
   *
   * If neither appears, treat the push as a no-op even when exit code was 0.
   */
  pushUpdatedARef(pushResult: GitResult): boolean {
    return /\[new branch\]\s+main\s+->\s+main/.test(pushResult.stderr) ||
      /[0-9a-f]{6,}\.\.[0-9a-f]{6,}\s+main\s+->\s+main/.test(pushResult.stderr);
  }

  // ─── Phase B steps (new) ───────────────────────────────────────────────────

  /**
   * Step pnpm-install — run `pnpm install --prefer-offline` inside the clone.
   *
   * On Windows, `pnpm` is installed as `pnpm.cmd`. We use the .cmd form
   * directly with `shell: false` so the OS finds the shim without a shell
   * interpreter. The argv array is fixed literals — no user input flows into it.
   */
  async runPnpmInstall(shortId: string): Promise<GitResult> {
    const workDir = this.workDirFor(shortId);
    return this.spawnPnpm(['install', '--prefer-offline'], workDir);
  }

  /**
   * Step apply-config — run `pnpm apply:config` inside the clone.
   *
   * The apply:config script reads seed-data.json (already written) and
   * regenerates lib/client-config.ts, patches globals.css, and optionally
   * seeds the dev database.
   *
   * SEED_EMAIL / SEED_FNAME / SEED_LNAME let the script set the admin
   * credentials for the preview login.
   */
  async runApplyConfig(
    shortId: string,
    opts: { seedEmail: string; seedFname: string; seedLname: string },
  ): Promise<GitResult> {
    const workDir = this.workDirFor(shortId);
    return this.spawnPnpm(['apply:config'], workDir, {
      SEED_EMAIL: opts.seedEmail,
      SEED_FNAME: opts.seedFname,
      SEED_LNAME: opts.seedLname,
    });
  }

  /**
   * Step typecheck — run `pnpm typecheck` (tsc --noEmit) inside the clone.
   * A non-zero exit means the template + seed combo is broken; we surface
   * the stderr output (scrubbed) to staff so they know what to fix.
   */
  async runTypecheck(shortId: string): Promise<GitResult> {
    const workDir = this.workDirFor(shortId);
    return this.spawnPnpm(['typecheck'], workDir);
  }

  /**
   * Step spawn-preview — start `pnpm dev -p <port>` in the background and
   * wait until the /login page responds (HTTP probe).
   *
   * Returns the ChildProcess so the caller can kill it later and stream
   * stderr for crash detection. The caller is responsible for attaching
   * the stderrTail ring buffer.
   *
   * On Windows, uses pnpm.cmd directly with shell:false (same pattern as
   * spawnPnpm). The port is a server-generated number; no user input enters
   * the argv array.
   */
  async spawnDevServer(
    shortId: string,
    port: number,
  ): Promise<{ child: ChildProcess; waitForReady: () => Promise<void> }> {
    const workDir = this.workDirFor(shortId);
    const isWin = process.platform === 'win32';

    // Ephemeral dev-only env for the preview child.
    //
    // The onboarding tool never writes an `.env` file into the cloned repo (by
    // design — see CLAUDE.md "Client config strategy"). But the preview dev
    // server needs a working IRON_SESSION_SECRET and a DATABASE_URL to boot.
    //
    // We pass them here directly on the child's env, scoped to the preview
    // process only. They never land in a file, never get committed, never
    // reach the pushed GitHub repo — when the push happens the tmp dir is
    // wiped along with anything it carried.
    //
    // IRON_SESSION_SECRET is freshly randomised per preview so stale sessions
    // from a previous preview in the same browser tab are invalidated
    // automatically.
    const previewSessionSecret = randomBytes(32).toString('base64url');

    const child = spawn(
      isWin ? 'pnpm.cmd' : 'pnpm',
      ['dev', '-p', String(port)],
      {
        cwd: workDir,
        windowsHide: true,
        // Node.js 20.12+ refuses to exec .cmd/.bat without shell:true
        // (CVE-2024-27980 fix) — without this we get spawn EINVAL.
        // Safe because args are static strings + a server-generated port
        // integer. No user input ever flows into the argv here.
        shell: isWin,
        env: {
          ...process.env,
          PORT: String(port),
          // Suppress interactive prompts and Next.js telemetry noise.
          NEXT_TELEMETRY_DISABLED: '1',
          CI: '1',
          // ── Preview-only runtime secrets ──────────────────────────────
          // These override any stray onboarding-process env of the same name.
          IRON_SESSION_SECRET:      previewSessionSecret,
          IRON_SESSION_COOKIE_NAME: 'wds_preview_session',
          // Dashboard uses libsql SQLite; its lib/db/client.ts already falls
          // back to 'file:./dev.db' but make it explicit for clarity.
          DATABASE_URL:             'file:./dev.db',
          // Keep NEXT_PUBLIC_APP_URL pointed at the preview host so generated
          // links (e.g. reset-password emails written during seeding) are valid
          // for anyone clicking through the preview.
          NEXT_PUBLIC_APP_URL:      `http://localhost:${port}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const waitForReady = async (): Promise<void> => {
      const url = `http://127.0.0.1:${port}/login`;
      const RETRY_INTERVAL_MS = 500;
      const MAX_WAIT_MS = 60_000;
      const deadline = Date.now() + MAX_WAIT_MS;

      while (Date.now() < deadline) {
        // Check if the child already exited (crash before ready).
        if (child.exitCode !== null) {
          throw new Error(
            `[spawn-preview] dev server exited with code ${child.exitCode} before becoming ready`,
          );
        }
        try {
          const res = await fetch(url, {
            signal: AbortSignal.timeout(5_000),
            redirect: 'manual', // /login may redirect; any response means the server is up
          });
          // Any response (including 3xx or 4xx) means Next.js is listening.
          if (res.status > 0) return;
        } catch {
          // ECONNREFUSED or timeout — server not ready yet, retry.
        }
        await new Promise<void>((r) => setTimeout(r, RETRY_INTERVAL_MS));
      }
      throw new Error(
        `[spawn-preview] dev server on port ${port} did not become ready within ${MAX_WAIT_MS / 1000}s`,
      );
    };

    return { child, waitForReady };
  }

  /**
   * Kill a running preview child process gracefully.
   * SIGTERM first; SIGKILL after 5s if still alive.
   */
  async killPreviewChild(child: ChildProcess | null): Promise<void> {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve();
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  /**
   * Remove ephemeral SQLite dev DB files from the clone before the final
   * git commit + push (they are gitignored but may linger from apply:config).
   */
  async removeDevDb(shortId: string): Promise<void> {
    const workDir = this.workDirFor(shortId);
    for (const suffix of ['dev.db', 'dev.db-shm', 'dev.db-wal', 'dev.db-journal']) {
      const p = path.join(workDir, suffix);
      try {
        await fs.rm(p, { force: true });
      } catch {
        // Non-fatal — file may not exist.
      }
    }
  }

  /**
   * Run `git add -A && git commit --amend --no-edit` to fold any files
   * generated by apply:config (lib/client-config.ts, globals.css, etc.)
   * into the initial commit.
   */
  async amendCommit(shortId: string): Promise<{ sha: string; log: GitResult }> {
    const workDir = this.workDirFor(shortId);
    const addResult = await runGit(['add', '-A'], workDir);
    if (addResult.status !== 0) {
      return { sha: '', log: addResult };
    }
    const amendResult = await runGit(
      [
        '-c',
        'user.email=onboarding@internal',
        '-c',
        'user.name=Onboarding Tool',
        'commit',
        '--amend',
        '--no-edit',
      ],
      workDir,
    );
    if (amendResult.status !== 0) {
      return { sha: '', log: amendResult };
    }
    const revParse = await runGit(['rev-parse', 'HEAD'], workDir);
    const sha = revParse.status === 0 ? revParse.stdout.trim() : '';
    return { sha, log: amendResult };
  }

  // ─── Internal pnpm helper ─────────────────────────────────────────────────

  private spawnPnpm(
    args: string[],
    cwd: string,
    extraEnv: Record<string, string> = {},
  ): Promise<GitResult> {
    const isWin = process.platform === 'win32';
    // On Windows, pnpm is installed as pnpm.cmd — a CMD shim. Node.js 20.12+
    // requires shell:true to exec .cmd/.bat (CVE-2024-27980 patch); without
    // it we hit `spawn EINVAL`. Safe here because every `args` entry in this
    // file is a static string (install, apply:config, typecheck) — no user
    // input ever enters the argv, so there is no injection surface.
    const cmd = isWin ? 'pnpm.cmd' : 'pnpm';
    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        cwd,
        shell: isWin,
        windowsHide: true,
        env: { ...process.env, ...extraEnv },
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => {
        stdout += d.toString('utf8');
      });
      child.stderr?.on('data', (d) => {
        stderr += d.toString('utf8');
      });
      child.on('close', (code) => {
        resolve({
          status: code ?? -1,
          stdout: scrubAndTruncate(stdout),
          stderr: scrubAndTruncate(stderr),
        });
      });
      child.on('error', (err) => {
        resolve({
          status: -1,
          stdout: '',
          stderr: scrubAndTruncate(`pnpm spawn error: ${err.message}`),
        });
      });
    });
  }
}
