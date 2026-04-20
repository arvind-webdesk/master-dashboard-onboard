#!/usr/bin/env node
/**
 * PreToolUse hook — blocks Write/Edit on sensitive paths and rejects
 * content that looks like hard-coded GitHub tokens or client credentials.
 *
 * This tool clones a template repo and creates a new per-client GitHub
 * repository. The most dangerous secret in this repo is GITHUB_TOKEN,
 * a fine-grained PAT with repo + admin:org on the company GitHub org.
 * Guard it aggressively.
 *
 * Wired in settings.json under hooks.PreToolUse for Write/Edit/MultiEdit.
 */

const fs = require('fs');

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

// Paths we refuse to touch from Claude.
// NOTE: `.env.example` / `.env.sample` are intentionally allowed — they are
// placeholder templates that must be committed. Real secret files are blocked.
const BLOCKED_PATHS = [
  /(^|[\\/])\.env$/i,
  /(^|[\\/])\.env\.(local|development|production|test|prod|dev)(\.[^\\/]+)?$/i,
  /(^|[\\/])secrets?($|[\\/])/i,
  /(^|[\\/])credentials($|[\\/])/i,
  /\.pem$/i,
  /\.key$/i,
  // Per-client temp clones should never be edited by Claude
  /(^|[\\/])tmp[\\/]prov-/i,
];

// Content patterns that look like committed secrets
const SECRET_PATTERNS = [
  { name: 'GitHub classic token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub fine-grained PAT', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'GitHub token assignment', re: /github[_-]?token\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/i },
  { name: 'x-access-token URL', re: /x-access-token:[A-Za-z0-9_\-\.]+@github\.com/i },
  { name: 'Bearer token', re: /bearer\s+[A-Za-z0-9_\-\.=]{20,}/i },
  { name: 'Private key header', re: /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/ },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Shopify access token', re: /shpat_[a-f0-9]{32,}/i },
  { name: 'Postgres URL with password', re: /postgres(ql)?:\/\/[^:]+:[^@\s]{8,}@/i },
  { name: 'Generic API key', re: /(api[_-]?key|apikey)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/i },
];

function block(reason) {
  process.stderr.write(`[protect-secrets] ${reason}\n`);
  process.exit(2);
}

try {
  const payload = JSON.parse(readStdin() || '{}');
  const input = payload.tool_input || {};
  const filePath = input.file_path || '';
  const content = input.content || input.new_string || '';

  if (filePath) {
    for (const re of BLOCKED_PATHS) {
      if (re.test(filePath)) {
        block(`Refusing to modify protected path: ${filePath}. Secrets live in env vars at runtime, not on disk. Temp clones are managed by ProvisioningService.`);
      }
    }
  }

  if (content) {
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(content)) {
        block(`Content looks like a hard-coded secret (${name}). Read it from process.env at runtime inside GitHubClient, never commit it.`);
      }
    }
  }

  process.exit(0);
} catch (err) {
  process.stderr.write(`[protect-secrets] hook error: ${err.message}\n`);
  process.exit(0);
}
