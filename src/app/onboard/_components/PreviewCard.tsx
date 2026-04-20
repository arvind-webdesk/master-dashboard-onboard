'use client';

import { useEffect, useState, useTransition } from 'react';
import { approveProvisioning, cancelProvisioning } from '../actions';
import { PrimaryButton, SecondaryButton } from './fields';

/**
 * Previewing state card — shown after apply:config succeeds and the dev server
 * is ready. Staff inspects the preview in another tab, then clicks Approve or
 * Cancel here.
 */

interface Props {
  sessionId: string;
  previewUrl: string;
  adminEmail: string;
  expiresAt: string; // ISO 8601
  clientName: string;
  disabledModules: string[]; // keys that were NOT enabled (for the checklist)
  onApproved: (repoUrl: string, warnings?: string[]) => void;
  onCancelled: () => void;
  onReApply: () => void;
}

export function PreviewCard({
  sessionId,
  previewUrl,
  adminEmail,
  expiresAt,
  clientName,
  disabledModules,
  onApproved,
  onCancelled,
  onReApply,
}: Props) {
  const [countdown, setCountdown] = useState('');
  const [approveOpen, setApproveOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [approving, startApprove] = useTransition();
  const [cancelling, startCancel] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [copiedEmail, setCopiedEmail] = useState(false);

  // Countdown timer.
  useEffect(() => {
    const expires = new Date(expiresAt).getTime();
    function tick() {
      const diff = expires - Date.now();
      if (diff <= 0) {
        setCountdown('Expired');
        return;
      }
      const m = Math.floor(diff / 60_000);
      const s = Math.floor((diff % 60_000) / 1000);
      setCountdown(`${m}:${s.toString().padStart(2, '0')}`);
    }
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [expiresAt]);

  function handleApprove() {
    setError(null);
    startApprove(async () => {
      const result = await approveProvisioning(sessionId);
      if (result.ok && result.repoUrl) {
        onApproved(result.repoUrl, result.warnings);
      } else {
        setApproveOpen(false);
        setError(result.friendlyError ?? 'Approval failed. Please try again.');
      }
    });
  }

  function handleCancel() {
    setError(null);
    startCancel(async () => {
      await cancelProvisioning(sessionId);
      onCancelled();
    });
  }

  async function copyEmail() {
    try {
      await navigator.clipboard.writeText(adminEmail);
      setCopiedEmail(true);
      setTimeout(() => setCopiedEmail(false), 1500);
    } catch {
      // silent
    }
  }

  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50 p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-blue-900">Preview is ready</h2>
          <p className="mt-0.5 text-sm text-blue-800">
            Check the dashboard in the tab below, then Approve or Cancel here.
          </p>
        </div>
        <div className="shrink-0 rounded-full bg-blue-100 px-3 py-1 text-sm font-mono text-blue-800">
          Expires in {countdown}
        </div>
      </div>

      <a
        href={previewUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-4 flex items-center gap-2 rounded-lg border border-blue-300 bg-white px-4 py-3 text-sm font-medium text-blue-900 hover:bg-blue-50"
      >
        <span className="text-base">Open preview</span>
        <span className="ml-1 font-mono text-xs text-blue-600">{previewUrl}</span>
        <span className="ml-auto text-xs text-blue-500">opens in new tab</span>
      </a>

      <div className="mt-4 rounded-lg border border-blue-200 bg-white p-3">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
          Sign in with
        </p>
        <div className="flex items-center gap-2 text-sm">
          <span className="w-16 text-gray-500">Email</span>
          <span className="font-mono text-gray-900">{adminEmail}</span>
          <button
            type="button"
            onClick={copyEmail}
            className="ml-2 rounded px-2 py-0.5 text-xs border border-surface-border hover:bg-surface-muted"
          >
            {copiedEmail ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="mt-1 text-xs text-gray-500">
          The password was set by the seed script (check the template default or
          SEED_PASSWORD env if you changed it).
        </p>
      </div>

      <div className="mt-4 rounded-lg border border-blue-200 bg-white p-3">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
          What to check
        </p>
        <ul className="space-y-1.5 text-sm text-gray-800">
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-gray-400">&#9744;</span>
            Brand color on login button and focus rings
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-gray-400">&#9744;</span>
            Client name &ldquo;{clientName}&rdquo; shown in the sidebar
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-gray-400">&#9744;</span>
            Logo appears in the sidebar header (if configured)
          </li>
          {disabledModules.length > 0 ? (
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-gray-400">&#9744;</span>
              Disabled modules are hidden from the sidebar:{' '}
              <span className="font-mono text-xs">{disabledModules.join(', ')}</span>
            </li>
          ) : null}
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-gray-400">&#9744;</span>
            Each enabled module loads without errors
          </li>
        </ul>
      </div>

      {error ? (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          {error}
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-3 border-t border-blue-200 pt-4">
        <PrimaryButton
          type="button"
          onClick={() => setApproveOpen(true)}
          disabled={approving || cancelling}
        >
          {approving ? 'Creating repo…' : 'Approve & create repo'}
        </PrimaryButton>
        <SecondaryButton
          type="button"
          onClick={onReApply}
          disabled={approving || cancelling}
        >
          Re-apply
        </SecondaryButton>
        <SecondaryButton
          type="button"
          onClick={() => setCancelOpen(true)}
          disabled={approving || cancelling}
          className="text-red-700 border-red-200 hover:bg-red-50"
        >
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </SecondaryButton>
      </div>

      {/* Approve confirmation dialog */}
      {approveOpen ? (
        <ConfirmDialog
          title="Create the repository?"
          body={
            <>
              <p className="text-sm text-gray-600">
                You are about to create a private GitHub repository for{' '}
                <strong>{clientName}</strong> and push the configured dashboard code to it.
              </p>
              <p className="mt-2 text-sm text-gray-600">
                Once the repo is created it cannot be automatically deleted by this tool.
                Make sure the preview looks correct before continuing.
              </p>
            </>
          }
          confirmLabel="Yes, create the repo"
          onCancel={() => setApproveOpen(false)}
          onConfirm={handleApprove}
          loading={approving}
        />
      ) : null}

      {/* Cancel confirmation dialog */}
      {cancelOpen ? (
        <ConfirmDialog
          title="Discard this preview?"
          body={
            <p className="text-sm text-gray-600">
              This will discard the preview and delete the temporary files. No GitHub repository
              will be created. You can start a new Apply &amp; preview from the form.
            </p>
          }
          confirmLabel="Yes, discard"
          confirmDanger
          onCancel={() => setCancelOpen(false)}
          onConfirm={handleCancel}
          loading={cancelling}
        />
      ) : null}
    </div>
  );
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  confirmDanger = false,
  onCancel,
  onConfirm,
  loading,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  confirmDanger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  loading: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <h2 className="text-lg font-semibold">{title}</h2>
        <div className="mt-2">{body}</div>
        <div className="mt-5 flex gap-3">
          <SecondaryButton type="button" onClick={onCancel} disabled={loading} className="flex-1">
            Go back
          </SecondaryButton>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-60 ${
              confirmDanger
                ? 'bg-red-700 hover:bg-red-800'
                : 'bg-gray-900 hover:bg-gray-800'
            }`}
          >
            {loading ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
