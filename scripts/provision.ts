/**
 * CLI shortcut for the /provision-client skill.
 *
 * Runs the same ProvisioningService as the web form, but from the terminal.
 * Used for smoke-testing the pipeline without opening a browser.
 *
 * Usage:
 *   npm run provision:cli -- --name "Acme Corp" --email admin@acme.com \
 *     --modules shopify,analytics --color "#FF6600" --by alice-gh
 */

import { parseArgs } from 'node:util';
import { ProvisioningService } from '../src/services/ProvisioningService';
import { normalizeSlug } from '../src/lib/slug';
import { runPreflight } from '../src/lib/preflight';

function fail(msg: string): never {
  console.error('✗ ' + msg);
  process.exit(1);
}

async function main() {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      slug: { type: 'string' },
      email: { type: 'string' },
      'admin-name': { type: 'string' },
      phone: { type: 'string' },
      industry: { type: 'string' },
      country: { type: 'string' },
      timezone: { type: 'string', default: 'Etc/UTC' },
      modules: { type: 'string' },
      color: { type: 'string', default: '#1e40af' },
      'secondary-color': { type: 'string' },
      logo: { type: 'string' },
      favicon: { type: 'string' },
      plan: { type: 'string', default: 'starter' },
      seats: { type: 'string', default: '5' },
      'go-live': { type: 'string' },
      notes: { type: 'string' },
      by: { type: 'string' },
      'provisioning-id': { type: 'string' },
    },
  });

  if (!values.name) fail('--name is required');
  if (!values.email) fail('--email is required');
  if (!values['admin-name']) fail('--admin-name is required');
  if (!values.modules) fail('--modules is required (comma-separated keys)');
  if (!values.by) fail('--by is required (your GitHub login, for the audit log)');

  const plan = values.plan as 'starter' | 'pro' | 'enterprise';
  if (!['starter', 'pro', 'enterprise'].includes(plan)) {
    fail('--plan must be starter|pro|enterprise');
  }
  const seats = Number(values.seats);
  if (!Number.isInteger(seats) || seats < 1) fail('--seats must be a positive integer');

  const pre = runPreflight(true);
  if (!pre.ok) {
    const missing = pre.checks.filter((c) => !c.ok);
    console.error('✗ preflight failed:');
    for (const c of missing) console.error(`  - ${c.name}: ${c.message ?? 'not ok'}`);
    process.exit(1);
  }

  const slug = values.slug ?? normalizeSlug(values.name!);
  const modules = values.modules!.split(',').map((s) => s.trim()).filter(Boolean);

  console.log('Provisioning:');
  console.log('  name:    ' + values.name);
  console.log('  slug:    ' + slug);
  console.log('  email:   ' + values.email);
  console.log('  modules: ' + modules.join(', '));
  console.log('  color:   ' + values.color);
  console.log('  by:      ' + values.by);

  const service = new ProvisioningService();
  const result = await service.create({
    provisioningId: values['provisioning-id'],
    name: values.name!,
    slug,
    industry: values.industry ?? null,
    country: values.country ?? null,
    timezone: values.timezone!,
    adminName: values['admin-name']!,
    adminEmail: values.email!,
    adminPhone: values.phone ?? null,
    teamGithubUsernames: [],
    brandPrimaryColor: values.color!,
    brandSecondaryColor: values['secondary-color'] ?? null,
    brandLogoUrl: values.logo ?? null,
    brandFaviconUrl: values.favicon ?? null,
    enabledModules: modules,
    planTier: plan,
    userSeats: seats,
    goLiveDate: values['go-live'] ?? null,
    notes: values.notes ?? null,
    provisionedBy: values.by!,
  });

  console.log('');
  if (result.status === 'READY') {
    console.log('✓ Ready');
    console.log('  repo: ' + result.repoUrl);
    console.log('  provisioningId: ' + result.provisioningId);
  } else {
    console.log('✗ Failed');
    console.log('  ' + result.friendlyError);
    if (result.referenceId) console.log('  reference: ' + result.referenceId);
    console.log('  provisioningId (pass as --provisioning-id to retry): ' + result.provisioningId);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[provision]', err instanceof Error ? err.message : err);
  process.exit(1);
});
