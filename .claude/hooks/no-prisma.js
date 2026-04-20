#!/usr/bin/env node
/**
 * PreToolUse hook — blocks any Write/Edit that introduces Prisma ORM imports
 * or usage into the dashboard codebase.
 *
 * This dashboard uses Drizzle ORM (drizzle-orm/pg-core) exclusively.
 * Prisma must never appear in this repo.
 *
 * Wired in settings.json under hooks.PreToolUse for Write/Edit/MultiEdit,
 * runs alongside protect-secrets.js.
 */

const fs = require('fs');

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

// Patterns that indicate Prisma is being introduced
const PRISMA_PATTERNS = [
  { name: 'Prisma client import (ESM)',   re: /from\s+['"]@prisma\/client['"]/i },
  { name: 'Prisma client import (CJS)',   re: /require\s*\(\s*['"]@prisma\/client['"]\s*\)/i },
  { name: 'Prisma bare import',           re: /from\s+['"]prisma['"]/i },
  { name: 'PrismaClient constructor',     re: /new\s+PrismaClient\s*[\(\{]/i },
  { name: 'PrismaClient named import',    re: /import\s*\{[^}]*PrismaClient[^}]*\}/i },
  { name: 'Prisma namespace import',      re: /import\s+\*\s+as\s+Prisma\s+from/i },
  { name: 'Prisma schema directive',      re: /datasource\s+db\s*\{[\s\S]*?provider\s*=\s*["']/i },
  { name: 'Prisma model directive',       re: /^model\s+\w+\s*\{/m },
];

function block(reason) {
  process.stderr.write(`[no-prisma] ${reason}\n`);
  process.exit(2);
}

try {
  const payload = JSON.parse(readStdin() || '{}');
  const input   = payload.tool_input || {};
  const content = input.content || input.new_string || '';
  const filePath = input.file_path || '';

  // Only check TypeScript/JavaScript files and Prisma schema files
  const isCheckable = /\.(ts|tsx|js|mjs|cjs|prisma)$/i.test(filePath) || filePath === '';

  if (!isCheckable) {
    process.exit(0);
  }

  // Allow schema files that are explicitly in prisma/ dirs for the onboarding tool
  // (the onboarding tool itself uses Prisma; only the new dashboard should not)
  // Heuristic: if the path contains the new dashboard directory, enforce strictly.
  // For all other paths, still warn but enforce.
  const inNewDashboard = /wds-dashboard-next/i.test(filePath);

  if (content) {
    for (const { name, re } of PRISMA_PATTERNS) {
      if (re.test(content)) {
        block(
          `Prisma ORM detected (${name}) — this dashboard uses Drizzle ORM exclusively.\n` +
          `  ✗ Remove: ${name}\n` +
          `  ✓ Use instead: import { pgTable, serial, varchar } from 'drizzle-orm/pg-core'\n` +
          `  ✓ See examples: lib/db/schema/*.ts\n` +
          `  ✓ DB client:    import { db } from '@/lib/db/client'\n` +
          (inNewDashboard ? '' : '\n  Note: the onboarding tool (this repo) uses Prisma — this block applies to new dashboard files only.')
        );
      }
    }
  }

  process.exit(0);
} catch (err) {
  process.stderr.write(`[no-prisma] hook error: ${err.message}\n`);
  process.exit(0); // Don't block on hook errors
}
