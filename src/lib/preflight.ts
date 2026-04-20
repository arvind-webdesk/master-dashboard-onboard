import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { getEnvStatus } from './env';

/**
 * Boot-time sanity checks for the provisioning pipeline.
 *
 * Called before serving any provisioning request. Returns a structured report
 * so the UI can tell staff "git is missing, contact admin" instead of crashing
 * on the first `spawn('git', ...)` call.
 */

export interface PreflightReport {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; message?: string }>;
}

let _cache: { at: number; report: PreflightReport } | null = null;
const CACHE_TTL_MS = 30_000;

export function runPreflight(force = false): PreflightReport {
  if (!force && _cache && Date.now() - _cache.at < CACHE_TTL_MS) {
    return _cache.report;
  }

  const checks: PreflightReport['checks'] = [];

  // 1. git on PATH
  try {
    const result = spawnSync('git', ['--version'], { encoding: 'utf8' });
    if (result.status === 0 && /^git version/i.test(result.stdout)) {
      checks.push({ name: 'git', ok: true, message: result.stdout.trim() });
    } else {
      checks.push({
        name: 'git',
        ok: false,
        message: 'git --version failed. Install Git for Windows and restart the app.',
      });
    }
  } catch {
    checks.push({
      name: 'git',
      ok: false,
      message: 'git binary not found on PATH. Install Git for Windows and restart the app.',
    });
  }

  // 2. tmp/ writable
  try {
    const tmpDir = path.resolve(process.cwd(), 'tmp');
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    checks.push({ name: 'tmp-writable', ok: true });
  } catch (err) {
    checks.push({
      name: 'tmp-writable',
      ok: false,
      message: `tmp/ is not writable: ${(err as Error).message}`,
    });
  }

  // 3. Env status (names only)
  const env = getEnvStatus();
  checks.push({
    name: 'staff-auth-env',
    ok: env.staffAuth,
    message: env.staffAuth ? undefined : 'Missing staff-auth vars — see .env.example',
  });
  checks.push({
    name: 'provisioning-env',
    ok: env.provisioning,
    message: env.provisioning ? undefined : 'Missing provisioning vars — see .env.example',
  });

  const report: PreflightReport = {
    ok: checks.every((c) => c.ok),
    checks,
  };
  _cache = { at: Date.now(), report };
  return report;
}
