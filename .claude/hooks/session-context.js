#!/usr/bin/env node
/**
 * SessionStart hook — prints a compact project status block that gets
 * injected into Claude's context at the start of every session.
 *
 * This tool is an INTERNAL onboarding form that clones a template repo
 * and creates a new per-client GitHub repo. No multi-tenant, no deploy
 * (yet). Reminders reflect that architecture.
 *
 * Wired in settings.json under hooks.SessionStart.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function safe(fn, fallback = '') {
  try { return fn(); } catch { return fallback; }
}

const cwd = process.cwd();
const isGit = fs.existsSync(path.join(cwd, '.git'));

const branch = isGit
  ? safe(() => execSync('git rev-parse --abbrev-ref HEAD', { cwd }).toString().trim())
  : '(not a git repo)';
const lastCommit = isGit
  ? safe(() => execSync('git log -1 --pretty=format:"%h %s (%cr)"', { cwd }).toString().trim())
  : '';
const dirty = isGit
  ? safe(() => execSync('git status --porcelain', { cwd }).toString().trim())
  : '';

// Env hints (names only — never values)
const envHints = [
  { key: 'GITHUB_TOKEN', label: 'GitHub token' },
  { key: 'GITHUB_ORG', label: 'target org' },
  { key: 'TEMPLATE_REPO_URL', label: 'template repo URL' },
  { key: 'DATABASE_URL', label: 'onboarding DB' },
];
const envStatus = envHints.map(h => `  ${h.label}: ${process.env[h.key] ? 'set' : 'missing'}`).join('\n');

// Count provisioned clients from tenants/clients dir if present
const clientsDir = path.join(cwd, 'data', 'clients');
const clientCount = fs.existsSync(clientsDir)
  ? fs.readdirSync(clientsDir).filter(f => f.endsWith('.json')).length
  : 0;

const lines = [
  '## Internal Onboarding Tool — Status',
  `Branch: ${branch}`,
  lastCommit ? `Last commit: ${lastCommit}` : null,
  dirty ? `Uncommitted changes: yes (${dirty.split('\n').length} files)` : `Uncommitted changes: no`,
  `Provisioned client records: ${clientCount}`,
  '',
  'Required env (status only — values never shown):',
  envStatus,
  '',
  'Architecture reminders (Phase 1 — clone & push, no deploy):',
  '- This repo = internal onboarding form used by non-tech staff.',
  '- Per provisioning: clone TEMPLATE_REPO_URL → new per-client GitHub repo → commit & push.',
  '- No multi-tenant logic. Each client gets their own separate repo.',
  '- GITHUB_TOKEN is read only inside GitHubClient; never log it, never commit it, never put it in a client .env.',
  '- Git commands must use spawn(cmd, [argv]) — never shell:true, never string-interpolate user input.',
  '- Run the security-auditor agent after any change to provisioning, auth, or the clients DB.',
];

process.stdout.write(lines.filter(l => l !== null).join('\n') + '\n');
process.exit(0);
