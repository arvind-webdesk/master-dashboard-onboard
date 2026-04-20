#!/usr/bin/env node
/**
 * PostToolUse hook — auto-detect common error patterns in Bash output and
 * inject a structured "DETECTED / SUGGESTED FIX" panel into Claude's context.
 *
 * This hook does NOT change tool output. It writes additionalContext to
 * Claude's view via the JSON protocol so the next assistant turn can act on
 * the diagnosis without the user having to copy-paste the error.
 *
 * Wired in settings.json under hooks.PostToolUse[matcher=Bash].
 *
 * Pattern philosophy:
 *  - Every entry has: name, regex (or test fn), short fix, optional command.
 *  - When multiple patterns match, surface ALL of them — Claude can decide.
 *  - Never claim certainty. The output is "you probably want to…", not "do X".
 *  - Never propose destructive commands (rm -rf, git reset --hard, etc).
 */

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    process.exit(0);
  }

  const tool = payload.tool_name || payload.toolName || '';
  if (tool !== 'Bash') process.exit(0);

  const result = payload.tool_response || payload.toolResponse || {};
  const stdout = String(result.stdout || result.output || '');
  const stderr = String(result.stderr || '');
  const exitCode = Number(result.exit_code ?? result.exitCode ?? 0);
  const combined = `${stdout}\n${stderr}`;

  // Treat both non-zero exit AND any output that looks like an error message
  // as potentially-failing — TS, prisma, and next sometimes exit 0 but print
  // diagnostics on stdout.
  const hasErrorSignal =
    exitCode !== 0 ||
    /\b(error|err!|panic|fatal|enoent|cannot|failed|not found)\b/i.test(combined);
  if (!hasErrorSignal) process.exit(0);

  const detections = [];
  for (const p of PATTERNS) {
    if (p.test(combined)) {
      detections.push({ name: p.name, fix: p.fix, command: p.command });
    }
  }
  if (detections.length === 0) process.exit(0);

  // Format a compact panel that Claude will see at the top of the next turn.
  const lines = [
    '## ⚠ Auto-detected error pattern(s)',
    '',
    'The previous Bash command failed in a way the auto-fix hook recognizes.',
    'Pick the matching diagnosis and apply the suggested fix on the next turn.',
    '',
  ];
  for (const d of detections) {
    lines.push(`### ${d.name}`);
    lines.push(`**Likely fix:** ${d.fix}`);
    if (d.command) lines.push(`**Suggested command:** \`${d.command}\``);
    lines.push('');
  }
  lines.push(
    'If none of these match the actual root cause, ignore this panel and diagnose normally.',
  );

  // Claude Code PostToolUse hooks emit JSON with `hookSpecificOutput` to inject
  // additional context into Claude's view. See the hooks docs for the schema.
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: lines.join('\n'),
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
});

/**
 * Pattern catalogue. Order matters — list more specific patterns first.
 * Each entry: { name, test(combined) → boolean, fix, command? }
 */
const PATTERNS = [
  // ─── Next.js / React ───
  {
    name: "Next.js 'use server' file exports a non-async value",
    test: (s) =>
      /use server/i.test(s) &&
      /(only async functions can be exported|must be (an )?async function)/i.test(s),
    fix:
      "Inside a file with `'use server'`, every value-level export must be an async function. " +
      'Drop the `export` keyword from the offending const/let, OR move it into a separate ' +
      "non-`'use server'` file (e.g. src/lib/...) and re-import. Type and interface exports are fine.",
  },
  {
    name: 'Two parallel pages resolve to the same path (Next.js App Router)',
    test: (s) => /two parallel pages that resolve to the same path/i.test(s),
    fix:
      'Find the duplicate page.tsx files (e.g. /(auth)/signin/page.tsx and /signin/page.tsx) and ' +
      'remove the redundant one. Then clear the build cache.',
    command: 'rm -rf .next',
  },
  {
    name: 'Next.js stale build cache after route move',
    test: (s) => /Cannot find module.*\.next/i.test(s) || /\.next.*ENOENT/i.test(s),
    fix: 'Stale Next build manifest. Stop the dev server, delete .next, restart.',
    command: 'rm -rf .next',
  },

  // ─── React Hook Form / Zod ───
  {
    name: "Zod schema using .or(z.literal('')).transform(...) tripping the 'use server' validator",
    test: (s) =>
      /use server/i.test(s) &&
      /\.transform/i.test(s),
    fix:
      'Replace the `.optional().or(z.literal(\'\')).transform(...)` chain with ' +
      '`z.preprocess(v => v === \'\' ? undefined : v, z.string().optional())`. ' +
      "The preprocess function must be a top-level const, NOT inlined inside the schema, so the `'use server'` " +
      'validator does not walk into it.',
  },

  // ─── Prisma ───
  {
    name: 'Prisma cannot find DATABASE_URL',
    test: (s) => /Environment variable not found: DATABASE_URL/i.test(s),
    fix:
      'Prisma CLI does not read .env.local by default. Wrap the command with dotenv-cli ' +
      '(npm run prisma:* scripts already do this) or run a one-off via npx dotenv-cli -e .env.local.',
    command: 'npm run prisma:migrate',
  },
  {
    name: 'SQLite database file missing (Error code 14)',
    test: (s) => /Error code 14: Unable to open the database file/i.test(s),
    fix:
      'The SQLite file does not exist yet. Run prisma migrate to create it. Verify .env.local ' +
      'has DATABASE_URL="file:./dev.db" — the path is relative to prisma/, not the project root.',
    command: 'npm run prisma:migrate -- --name init',
  },
  {
    name: 'Prisma migration drift / unique constraint conflict in dev',
    test: (s) =>
      /(P3018|P3019|migration.*failed|unique constraint failed)/i.test(s) &&
      /prisma/i.test(s),
    fix:
      'Dev migration failed. If there is no real data in dev.db, the safe move is: stop the dev ' +
      'server, delete prisma/dev.db and prisma/migrations/, then re-run migrate. ' +
      'NEVER do this in production.',
  },

  // ─── npm / Node ───
  {
    name: 'npm peer dependency conflict (ERESOLVE)',
    test: (s) => /ERESOLVE.*Conflicting peer dependency/i.test(s),
    fix:
      'A package was pinned to a version that does not satisfy a peer requirement. ' +
      'Read the offending package and either bump it to a version compatible with the peer, ' +
      'or downgrade the peer. Use --legacy-peer-deps only as a last resort.',
  },
  {
    name: 'npm package missing on PATH (e.g. dotenv-cli not found)',
    test: (s) =>
      /(command not found|is not recognized as an internal or external command|sh: .* not found)/i.test(
        s,
      ),
    fix:
      'A binary used by an npm script is not installed. Run `npm install` to install all deps, ' +
      'then re-run the failing script.',
    command: 'npm install',
  },
  {
    name: 'Node heap out of memory during compile/typecheck',
    test: (s) =>
      /JavaScript heap out of memory/i.test(s) ||
      /MarkCompactCollector.*promotion failed/i.test(s),
    fix:
      'tsc / next ran out of heap. Re-run with NODE_OPTIONS=--max-old-space-size=4096. ' +
      'If it happens repeatedly, narrow tsc scope (per-file check) or use `next typegen` instead of ' +
      'a full project type-check.',
    command: 'NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit',
  },

  // ─── Git ───
  {
    name: 'git binary missing on PATH',
    test: (s) => /'git' is not recognized|git: command not found|spawn git ENOENT/i.test(s),
    fix:
      'Install Git for Windows from https://git-scm.com/download/win and restart the shell. ' +
      'Verify with `git --version`.',
  },
  {
    name: 'git push refused (auth or permission)',
    test: (s) => /(remote: Permission|fatal: Authentication failed|403 Forbidden)/i.test(s),
    fix:
      'GITHUB_TOKEN lacks the required scopes (repo + admin:org + delete_repo) or is expired. ' +
      'Generate a fresh fine-grained PAT with Administration write + Contents write on the target org.',
  },

  // ─── Filesystem ───
  {
    name: 'EBUSY/EPERM on Windows during tmp cleanup',
    test: (s) => /(EBUSY|EPERM).*resource busy or locked/i.test(s),
    fix:
      'A Windows process still has a handle on a file in tmp/. Wait a moment and retry, or kill ' +
      'the dev server briefly. Cleanup is non-fatal — provisioning still succeeded if the rest of ' +
      'the pipeline did.',
  },
  {
    name: 'TypeScript file not found / wrong path',
    test: (s) => /Cannot find module.*relative to/i.test(s) || /TS2307/i.test(s),
    fix:
      'Check the import path. tsconfig.json paths use the @/ alias for src/ — make sure the ' +
      'imported file actually exists at that path and is included in the include glob.',
  },
];
