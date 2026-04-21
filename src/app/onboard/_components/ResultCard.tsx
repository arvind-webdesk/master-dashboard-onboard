'use client';

import { useState } from 'react';
import type { IntegrationHandoff } from '../actions';

interface Props {
  result: {
    status: 'READY' | 'FAILED';
    repoUrl?: string;
    friendlyError?: string;
    referenceId?: string;
    warnings?: string[];
    integrationHandoff?: IntegrationHandoff;
  };
  /** Failure path — keep the same provisioningId, return to the Review step. */
  onRetry: () => void;
  /** Success path — reset the form, clear the provisioningId, start over. */
  onStartFresh: () => void;
}

export function ResultCard({ result, onRetry, onStartFresh }: Props) {
  if (result.status === 'READY' && result.repoUrl) {
    return (
      <SuccessCard
        repoUrl={result.repoUrl}
        warnings={result.warnings ?? []}
        handoff={result.integrationHandoff}
        onStartOver={onStartFresh}
      />
    );
  }
  return (
    <FailureCard
      message={result.friendlyError ?? 'Something went wrong. Please try again.'}
      referenceId={result.referenceId}
      onRetry={onRetry}
    />
  );
}

function SuccessCard({
  repoUrl,
  warnings,
  handoff,
  onStartOver,
}: {
  repoUrl: string;
  warnings: string[];
  handoff?: IntegrationHandoff;
  onStartOver: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(repoUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API unavailable — silent
    }
  }
  return (
    <div className="rounded-xl border border-green-200 bg-green-50 p-6">
      <h2 className="text-lg font-semibold text-green-900">Dashboard repository ready</h2>
      <p className="mt-1 text-sm text-green-800">
        Hand this URL to the client or to the dev who will set up hosting.
      </p>
      <div className="mt-4 rounded-lg border border-green-200 bg-white p-3">
        <code className="block break-all font-mono text-sm text-gray-900">{repoUrl}</code>
      </div>

      {handoff && (handoff.shopify || handoff.bigcommerce) ? (
        <HandoffBlock handoff={handoff} />
      ) : null}

      {warnings.length > 0 ? (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">A few things didn&apos;t complete cleanly:</p>
          <ul className="mt-1.5 list-inside list-disc space-y-1">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-amber-800">
            The dashboard repo is ready — these are minor follow-ups you can do manually on GitHub.
          </p>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={copy}
          className="rounded-lg bg-green-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-800"
        >
          {copied ? 'Copied ✓' : 'Copy URL'}
        </button>
        <a
          href={repoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg border border-green-200 bg-white px-3 py-1.5 text-sm font-medium text-green-900 hover:bg-green-50"
        >
          Open on GitHub
        </a>
        <button
          type="button"
          onClick={onStartOver}
          className="rounded-lg border border-surface-border bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-surface-muted"
        >
          Onboard another client
        </button>
      </div>
    </div>
  );
}

function HandoffBlock({ handoff }: { handoff: IntegrationHandoff }) {
  const lines: string[] = [];
  if (handoff.shopify) {
    lines.push(`SHOPIFY_STORE_URL=${handoff.shopify.storeUrl}`);
    lines.push(`SHOPIFY_ACCESS_TOKEN=${handoff.shopify.accessToken}`);
    if (handoff.shopify.webhookSecret)
      lines.push(`SHOPIFY_WEBHOOK_SECRET=${handoff.shopify.webhookSecret}`);
  }
  if (handoff.bigcommerce) {
    lines.push(`BIGCOMMERCE_STORE_HASH=${handoff.bigcommerce.storeHash}`);
    lines.push(`BIGCOMMERCE_ACCESS_TOKEN=${handoff.bigcommerce.accessToken}`);
    if (handoff.bigcommerce.clientId)
      lines.push(`BIGCOMMERCE_CLIENT_ID=${handoff.bigcommerce.clientId}`);
  }
  const block = lines.join('\n');
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(block);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — silent
    }
  }

  const masked = lines
    .map((l) => {
      const eq = l.indexOf('=');
      return eq < 0 ? l : `${l.slice(0, eq + 1)}${'•'.repeat(Math.min(l.length - eq - 1, 24))}`;
    })
    .join('\n');

  return (
    <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-amber-900">
            Commerce integration credentials — hand these to the client
          </p>
          <p className="mt-1 text-xs text-amber-800">
            These values were NOT committed to the repository. Paste them into the client&apos;s own{' '}
            <code className="font-mono">.env</code> at deploy time. You will not see them again
            after you leave this page.
          </p>
        </div>
      </div>
      <pre className="mt-3 overflow-x-auto rounded border border-amber-200 bg-white p-3 font-mono text-xs text-gray-900">
        {revealed ? block : masked}
      </pre>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
        >
          {revealed ? 'Hide values' : 'Reveal values'}
        </button>
        <button
          type="button"
          onClick={copy}
          className="rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-800"
        >
          {copied ? 'Copied ✓' : 'Copy .env block'}
        </button>
      </div>
    </div>
  );
}

function FailureCard({
  message,
  referenceId,
  onRetry,
}: {
  message: string;
  referenceId?: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-6">
      <h2 className="text-lg font-semibold text-red-900">Something went wrong</h2>
      <p className="mt-2 text-sm text-red-900">{message}</p>
      {referenceId ? (
        <p className="mt-2 text-xs text-red-800">
          If you contact support, please include reference{' '}
          <code className="font-mono">{referenceId}</code>.
        </p>
      ) : null}
      <div className="mt-4">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
