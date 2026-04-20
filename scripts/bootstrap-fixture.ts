/**
 * Create a local bare-repo fixture at tmp/fixtures/template.git for dev.
 *
 * This fills in for the real dashboard template until the user provides it.
 * The fixture has the minimum shape required by the validate-template step:
 * prisma/schema.prisma, prisma/seed.ts, README.md.
 *
 * Run with: `npm run bootstrap:fixture`
 * Then in .env.local set:
 *   TEMPLATE_REPO_URL="file:///<absolute-path-to>/tmp/fixtures/template.git"
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const FIXTURES_DIR = path.join(ROOT, 'tmp', 'fixtures');
const WORK_DIR = path.join(FIXTURES_DIR, 'template.work');
const BARE_DIR = path.join(FIXTURES_DIR, 'template.git');

function run(cmd: string, args: string[], cwd: string) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${res.stderr || res.stdout}`);
  }
}

async function main() {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(WORK_DIR, { recursive: true });

  // Minimum template files expected by validate-template.
  await fs.mkdir(path.join(WORK_DIR, 'prisma'), { recursive: true });

  await fs.writeFile(
    path.join(WORK_DIR, 'prisma', 'schema.prisma'),
    `// Fixture template — replace with the real dashboard template.
datasource db { provider = "sqlite"; url = env("DATABASE_URL") }
generator client { provider = "prisma-client-js" }

model ClientConfig {
  id                Int    @id @default(1)
  name              String
  slug              String @unique
  adminEmail        String
  brandPrimaryColor String
  brandLogoUrl      String?
  notes             String?
}

model ModuleEnablement {
  key     String @id
  enabled Boolean
}
`,
    'utf8',
  );

  await fs.writeFile(
    path.join(WORK_DIR, 'prisma', 'seed.ts'),
    `// Fixture seed — reads prisma/seed-data.json and upserts client config.
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const seedPath = path.resolve(__dirname, 'seed-data.json');
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  await prisma.clientConfig.upsert({
    where: { id: 1 },
    update: { ...seed.client },
    create: { id: 1, ...seed.client },
  });
  for (const mod of seed.modules) {
    await prisma.moduleEnablement.upsert({
      where: { key: mod.key },
      update: { enabled: mod.enabled },
      create: { key: mod.key, enabled: mod.enabled },
    });
  }
}

main().finally(() => prisma.$disconnect());
`,
    'utf8',
  );

  await fs.writeFile(
    path.join(WORK_DIR, 'README.md'),
    `# Fixture Template

This is a minimal local fixture used by the onboarding tool during development.
Replace with the real dashboard template when it is ready.
`,
    'utf8',
  );

  // Init, commit, then push to a bare repo so TEMPLATE_REPO_URL=file://...
  // works exactly like the real thing.
  run('git', ['init', '-b', 'main'], WORK_DIR);
  run('git', ['-c', 'user.email=fixture@internal', '-c', 'user.name=Fixture', 'add', '-A'], WORK_DIR);
  run(
    'git',
    [
      '-c',
      'user.email=fixture@internal',
      '-c',
      'user.name=Fixture',
      'commit',
      '-m',
      'fixture: initial template',
    ],
    WORK_DIR,
  );

  await fs.mkdir(BARE_DIR, { recursive: true });
  run('git', ['init', '--bare', '-b', 'main'], BARE_DIR);
  run('git', ['remote', 'add', 'origin', BARE_DIR], WORK_DIR);
  run('git', ['push', 'origin', 'main'], WORK_DIR);

  // Clean up the working copy; the bare repo is what we'll clone from.
  await fs.rm(WORK_DIR, { recursive: true, force: true });

  const fileUrl = 'file:///' + BARE_DIR.replace(/\\/g, '/');
  console.log('\n✓ Fixture bare repo ready at:');
  console.log('  ' + BARE_DIR);
  console.log('\nAdd this to .env.local:');
  console.log('  TEMPLATE_REPO_URL="' + fileUrl + '"\n');
}

main().catch((err) => {
  console.error('[bootstrap-fixture]', err);
  process.exit(1);
});
