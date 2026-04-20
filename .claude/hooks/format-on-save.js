#!/usr/bin/env node
/**
 * PostToolUse hook — runs prettier + eslint --fix on TS/TSX/JS files
 * after Claude writes or edits them. Silent on success, warns on failure.
 *
 * Wired in settings.json under hooks.PostToolUse for Write/Edit/MultiEdit.
 */

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

const FORMATTABLE = /\.(ts|tsx|js|jsx|mjs|cjs|json|css|scss|md)$/i;

try {
  const payload = JSON.parse(readStdin() || '{}');
  const filePath = (payload.tool_input && payload.tool_input.file_path) || '';

  if (!filePath || !FORMATTABLE.test(filePath)) {
    process.exit(0);
  }

  if (!fs.existsSync(filePath)) {
    process.exit(0);
  }

  // Resolve workspace root (assume hook runs from project root)
  const cwd = process.cwd();
  const hasPrettier = fs.existsSync(path.join(cwd, 'node_modules', '.bin', 'prettier'))
    || fs.existsSync(path.join(cwd, 'node_modules', '.bin', 'prettier.cmd'));
  const hasEslint = fs.existsSync(path.join(cwd, 'node_modules', '.bin', 'eslint'))
    || fs.existsSync(path.join(cwd, 'node_modules', '.bin', 'eslint.cmd'));

  const quoted = JSON.stringify(filePath);

  if (hasPrettier) {
    try {
      execSync(`npx prettier --write ${quoted}`, { stdio: 'pipe', cwd });
    } catch (e) {
      process.stderr.write(`[format-on-save] prettier failed on ${filePath}: ${e.message}\n`);
    }
  }

  if (hasEslint && /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(filePath)) {
    try {
      execSync(`npx eslint --fix ${quoted}`, { stdio: 'pipe', cwd });
    } catch (e) {
      // eslint exit code 1 means unfixable issues remain — surface to Claude
      process.stderr.write(`[format-on-save] eslint reported issues on ${filePath}. Fix before continuing.\n`);
    }
  }

  process.exit(0);
} catch (err) {
  process.stderr.write(`[format-on-save] hook error: ${err.message}\n`);
  process.exit(0);
}
