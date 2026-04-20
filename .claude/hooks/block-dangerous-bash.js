#!/usr/bin/env node
/**
 * PreToolUse hook for Bash — blocks destructive commands that shouldn't
 * run automatically from an agent session. The internal onboarding tool
 * creates per-client GitHub repos, so destructive git and GitHub CLI
 * commands are the biggest risk.
 */

const fs = require('fs');

const DANGEROUS = [
  // Filesystem
  { pattern: /\brm\s+-rf?\s+\/(\s|$)/, reason: 'rm -rf / is never acceptable' },
  { pattern: /\brm\s+-rf?\s+[~*]/, reason: 'wildcard rm -rf requires explicit user approval' },

  // Git destructive
  { pattern: /\bgit\s+push\s+.*--force(\s|$|\b)/, reason: 'force push requires explicit user approval' },
  { pattern: /\bgit\s+push\s+.*-f(\s|$)/, reason: 'force push (-f) requires explicit user approval' },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: 'git reset --hard discards work — ask the user first' },
  { pattern: /\bgit\s+clean\s+-[fdx]*f/, reason: 'git clean -f deletes untracked work — ask first' },
  { pattern: /\bgit\s+push\s+.*\bdashboard-template\b/, reason: 'never push to the template repo from this tool — it is read-only' },
  { pattern: /\bgit\s+push\s+.*\btemplate\b.*:main/, reason: 'refuse to push to any branch named template' },

  // GitHub CLI destructive
  { pattern: /\bgh\s+repo\s+delete\b/, reason: 'gh repo delete requires explicit user approval with a typed confirmation' },
  { pattern: /\bgh\s+api\s+-X\s*DELETE/i, reason: 'DELETE against the GitHub API requires explicit user approval' },

  // Secret exposure
  { pattern: /\bcat\s+.*\.env/, reason: 'do not cat .env files — secrets are read by the service at runtime' },
  { pattern: /\bprintenv\s+.*GITHUB_TOKEN/i, reason: 'do not print GITHUB_TOKEN' },
  { pattern: /\becho\s+.*\$\{?GITHUB_TOKEN/i, reason: 'do not echo GITHUB_TOKEN' },

  // Remote code execution
  { pattern: /\b(curl|wget)\s+[^|]*\|\s*(bash|sh|zsh)\b/, reason: 'piping remote content to a shell is unsafe' },

  // DB destructive (for the onboarding tool's own clients DB)
  { pattern: /\bDROP\s+(DATABASE|TABLE|SCHEMA)\b/i, reason: 'DROP statements must be reviewed by a human' },
  { pattern: /\bprisma\s+migrate\s+reset\b/, reason: 'prisma migrate reset wipes the dev DB — ask first' },
];

function block(reason) {
  process.stderr.write(`[block-dangerous-bash] Blocked: ${reason}\n`);
  process.exit(2);
}

try {
  const payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const cmd = (payload.tool_input && payload.tool_input.command) || '';

  for (const { pattern, reason } of DANGEROUS) {
    if (pattern.test(cmd)) {
      block(`${reason}\n  command: ${cmd}`);
    }
  }

  process.exit(0);
} catch (err) {
  process.stderr.write(`[block-dangerous-bash] hook error: ${err.message}\n`);
  process.exit(0);
}
