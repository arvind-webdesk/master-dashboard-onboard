import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { defaultModuleSource } from '@/lib/modules';

/**
 * Provisioned clients list — internal staff view of every client the
 * onboarding tool has touched (READY, PENDING, or FAILED).
 *
 * Server component. Reads Prisma directly because the page is staff-only and
 * gated by the same NextAuth session as /onboard.
 */
export default async function ClientsPage() {
  const session = await auth();
  if (!session?.user) redirect('/signin');

  const [clients, modules] = await Promise.all([
    prisma.client.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200, // arbitrary cap; Phase 1 is single-operator and will not exceed this
    }),
    defaultModuleSource.list(),
  ]);

  const moduleNameByKey = new Map(modules.map((m) => [m.key, m.displayName]));

  return (
    <div className="mx-auto max-w-5xl p-6 md:p-10">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Provisioned dashboards</h1>
          <p className="mt-1 text-sm text-gray-600">
            Every client onboarding the tool has attempted, newest first.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/onboard"
            className="rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800"
          >
            New dashboard
          </Link>
        </div>
      </header>

      <div className="mt-8">
        {clients.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="space-y-3">
            {clients.map((c) => (
              <ClientRow
                key={c.id}
                client={c}
                moduleNameByKey={moduleNameByKey}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-surface-border bg-surface-muted/40 p-10 text-center">
      <p className="text-sm text-gray-600">No clients have been provisioned yet.</p>
      <Link
        href="/onboard"
        className="mt-4 inline-block rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800"
      >
        Onboard your first client
      </Link>
    </div>
  );
}

interface ClientRowData {
  id: string;
  slug: string;
  name: string;
  status: string;
  industry: string | null;
  country: string | null;
  adminName: string;
  adminEmail: string;
  teamGithubUsernames: string | null;
  enabledModules: string;
  planTier: string;
  userSeats: number;
  githubRepoUrl: string | null;
  friendlyError: string | null;
  warnings: string | null;
  provisionedBy: string;
  createdAt: Date;
}

function ClientRow({
  client,
  moduleNameByKey,
}: {
  client: ClientRowData;
  moduleNameByKey: Map<string, string>;
}) {
  const moduleKeys = client.enabledModules.split(',').filter(Boolean);
  const teamMembers = client.teamGithubUsernames
    ? client.teamGithubUsernames.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const warningCount = client.warnings ? client.warnings.split('\n').filter(Boolean).length : 0;

  return (
    <li className="rounded-xl border border-surface-border bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <h2 className="truncate text-base font-semibold text-gray-900">{client.name}</h2>
            <StatusBadge status={client.status} />
            {warningCount > 0 ? (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-900">
                {warningCount} warning{warningCount > 1 ? 's' : ''}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-gray-500">
            <code className="font-mono">dashboard-{client.slug}</code>
            {client.industry ? ` · ${client.industry}` : ''}
            {client.country ? ` · ${client.country}` : ''}
          </p>
        </div>
        {client.githubRepoUrl ? (
          <a
            href={client.githubRepoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-surface-muted"
          >
            Open on GitHub ↗
          </a>
        ) : null}
      </div>

      <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2 md:grid-cols-3">
        <Cell label="Admin">
          {client.adminName}
          <span className="text-gray-500"> &lt;{client.adminEmail}&gt;</span>
        </Cell>
        <Cell label="Plan">
          {client.planTier} · {client.userSeats} seats
        </Cell>
        <Cell label="Provisioned by">
          <code className="font-mono">{client.provisionedBy}</code>{' '}
          <span className="text-gray-500">
            on {new Date(client.createdAt).toLocaleDateString()}
          </span>
        </Cell>
      </dl>

      <div className="mt-3">
        <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500">Modules</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {moduleKeys.length === 0 ? (
            <span className="text-xs text-gray-400">—</span>
          ) : (
            moduleKeys.map((k) => (
              <span
                key={k}
                className="rounded-full border border-surface-border bg-surface-muted px-2 py-0.5 text-xs text-gray-700"
                title={k}
              >
                {moduleNameByKey.get(k) ?? k}
              </span>
            ))
          )}
        </div>
      </div>

      {teamMembers.length > 0 ? (
        <div className="mt-3">
          <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
            Team / collaborators
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {teamMembers.map((u) => (
              <a
                key={u}
                href={`https://github.com/${u}`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full border border-surface-border bg-surface-muted px-2 py-0.5 font-mono text-xs text-gray-700 hover:border-gray-400 hover:bg-white"
                title={`Open @${u} on GitHub`}
              >
                @{u}
              </a>
            ))}
          </div>
        </div>
      ) : null}

      {client.status === 'FAILED' && client.friendlyError ? (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-900">
          {client.friendlyError}
        </div>
      ) : null}

      {warningCount > 0 && client.warnings ? (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <ul className="list-inside list-disc space-y-0.5">
            {client.warnings.split('\n').filter(Boolean).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] font-medium uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-0.5 truncate text-gray-800">{children}</dd>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles =
    status === 'READY'
      ? 'border-green-200 bg-green-50 text-green-900'
      : status === 'FAILED'
        ? 'border-red-200 bg-red-50 text-red-900'
        : 'border-gray-200 bg-gray-50 text-gray-700';
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${styles}`}
    >
      {status}
    </span>
  );
}
