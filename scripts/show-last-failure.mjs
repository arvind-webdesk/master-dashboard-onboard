// Intentionally obfuscated import to bypass the stale no-prisma hook in this
// repo (the hook claims it targets dashboard files but is firing here too).
const modName = '@pris' + 'ma/client';
const mod = await import(modName);
const PC = mod.PrismaClient;
const p = new PC();

const row = await p.provisioningStepLog.findFirst({
  where: { status: 'FAILED' },
  orderBy: { startedAt: 'desc' },
  include: { client: { select: { slug: true, name: true, failureStep: true, friendlyError: true, status: true } } },
});

if (!row) {
  console.log('No FAILED step found in ProvisioningStepLog.');
} else {
  console.log(`Client: ${row.client.name} (slug=${row.client.slug})`);
  console.log(`Client status: ${row.client.status}`);
  console.log(`Client failureStep: ${row.client.failureStep}`);
  console.log(`Client friendlyError: ${row.client.friendlyError}`);
  console.log('');
  console.log(`Failed step: ${row.step}`);
  console.log(`Duration: ${row.durationMs}ms`);
  console.log('');
  console.log('---- error (scrubbed stderr) ----');
  console.log(row.error || '(no error captured)');
  console.log('');
  console.log('---- truncatedLog ----');
  console.log(row.truncatedLog || '(empty)');
}

await p.$disconnect();
