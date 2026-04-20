'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Poll /api/provision/:id/status every 900ms until the backend reports a
 * terminal state, then fire onTerminal.
 *
 * Renders the FULL expected pipeline (not just the steps that have started),
 * with a per-step live elapsed timer for the currently-running step and
 * expandable error snippets for any FAILED step.
 *
 * Accepts either a provisioningId (32-char hex from the DB) or a sessionId
 * (also 32-char hex from the in-memory preview session). The status route
 * checks the in-memory map first, then falls back to the DB.
 *
 * `pipeline` tells the poller which canonical list of steps to render:
 *   - 'apply'   = clone → write-seed → install → apply-config → typecheck → git-reinit → spawn-preview
 *   - 'approve' = create-repo → push → invite-collaborator → finalize
 *   - 'full'    = both (default, legacy)
 */

/** Human-friendly labels for every step name the backend may emit. */
const STEP_LABELS: Record<string, string> = {
  validate:                'Checking your inputs',
  'slug-check':            'Looking for name collisions',
  'create-client-row':     'Recording the request',
  'clone-template':        'Downloading the dashboard template',
  'validate-template':     'Verifying the template',
  'write-seed':            'Writing client configuration',
  'pnpm-install':          'Installing dependencies',
  'apply-config':          'Applying client configuration',
  typecheck:               'Type-checking the template',
  'git-reinit':            'Preparing the initial commit',
  'spawn-preview':         'Starting preview server',
  'create-repo':           'Creating the GitHub repository',
  push:                    'Uploading files to GitHub',
  'invite-collaborator':   'Inviting client GitHub user',
  finalize:                'Finalizing',
};

/** Canonical step order per phase. The poller renders these upfront as 'pending'. */
const PIPELINE_APPLY: readonly string[] = [
  'validate',
  'slug-check',
  'create-client-row',
  'clone-template',
  'validate-template',
  'write-seed',
  'pnpm-install',
  'apply-config',
  'typecheck',
  'git-reinit',
  'spawn-preview',
];
const PIPELINE_APPROVE: readonly string[] = [
  'create-repo',
  'push',
  'invite-collaborator',
  'finalize',
];
const PIPELINE_FULL: readonly string[] = [...PIPELINE_APPLY, ...PIPELINE_APPROVE];

interface StepRow {
  step:          string;
  status:        'STARTED' | 'OK' | 'FAILED';
  startedAt:     string;
  finishedAt:    string | null;
  durationMs:    number | null;
  error:         string | null;
  truncatedLog:  string | null;
}

interface Terminal {
  status:         'READY' | 'FAILED';
  repoUrl?:       string;
  friendlyError?: string;
  referenceId?:   string;
  warnings?:      string[];
}

interface Props {
  provisioningId: string;
  onTerminal:     (t: Terminal) => void;
  /** Which canonical pipeline to render upfront. Defaults to `full`. */
  pipeline?:      'apply' | 'approve' | 'full';
  /** Heading above the list. */
  title?:         string;
  /** Subtitle below the heading. */
  subtitle?:      string;
}

export function ProgressPoller({
  provisioningId,
  onTerminal,
  pipeline = 'full',
  title = 'Working on it…',
  subtitle = 'This usually takes under a minute. Keep this tab open.',
}: Props) {
  const [steps, setSteps] = useState<StepRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Tick every 100ms so the running step's elapsed timer updates smoothly.
  const [, setNow] = useState<number>(() => Date.now());

  const terminalFiredRef = useRef(false);

  // ─── Live ticker for running step elapsed time ──────────────────────────
  useEffect(() => {
    const hasRunning = steps.some((s) => s.status === 'STARTED');
    if (!hasRunning) return;
    const interval = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(interval);
  }, [steps]);

  // ─── Polling loop ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      if (cancelled || terminalFiredRef.current) return;
      try {
        const res = await fetch(`/api/provision/${provisioningId}/status`, {
          cache: 'no-store',
        });
        // 404 is expected briefly at the very start of a client-generated-id flow
        // (DB row hasn't been written yet). Retry silently.
        if (res.status === 404) {
          timer = setTimeout(tick, 900);
          return;
        }
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = (await res.json()) as {
          kind?:            'preview-session' | 'provisioning';
          status?:          'PENDING' | 'PREVIEW_PENDING' | 'READY' | 'FAILED' | 'CANCELLED';
          repoUrl?:         string | null;
          friendlyError?:   string | null;
          referenceId?:     string | null;
          warnings?:        string[];
          steps?:           StepRow[];
          state?:           'applying' | 'previewing' | 'approving' | 'done' | 'cancelled' | 'failed';
          previewUrl?:      string;
          expiresAt?:       string;
        };
        if (cancelled) return;

        if (body.kind === 'provisioning') {
          setSteps(body.steps ?? []);
          if (body.status === 'READY') {
            terminalFiredRef.current = true;
            onTerminal({
              status:    'READY',
              repoUrl:   body.repoUrl ?? undefined,
              warnings:  body.warnings ?? [],
            });
            return;
          }
          if (body.status === 'FAILED' || body.status === 'CANCELLED') {
            terminalFiredRef.current = true;
            onTerminal({
              status:        'FAILED',
              friendlyError: body.friendlyError ?? undefined,
              referenceId:   body.referenceId ?? undefined,
              warnings:      body.warnings ?? [],
            });
            return;
          }
        }
        // For preview-session responses the parent component handles state
        // transitions; this poller just stops. (OnboardForm unmounts us.)
      } catch (err) {
        setError(`Connection hiccup: ${(err as Error).message}`);
      }
      timer = setTimeout(tick, 900);
    }

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [provisioningId, onTerminal]);

  // ─── Build the display list: merge canonical pipeline with live step rows ──
  const expected = pipeline === 'apply' ? PIPELINE_APPLY
                 : pipeline === 'approve' ? PIPELINE_APPROVE
                 : PIPELINE_FULL;
  // Fast index by step name from the latest poll.
  const stepByName = new Map<string, StepRow>();
  for (const s of steps) stepByName.set(s.step, s);

  // Show unknown steps (ones we didn't list upfront) below the canonical ones
  // so nothing gets dropped if the backend adds new step names.
  const unknown = steps.filter((s) => !expected.includes(s.step));

  function toggleExpanded(key: string) {
    setExpanded((e) => ({ ...e, [key]: !e[key] }));
  }

  return (
    <div className="rounded-xl border border-surface-border bg-white p-6 shadow-sm">
      <h2 className="text-sm font-semibold text-gray-800">{title}</h2>
      <p className="mt-1 text-xs text-gray-500">{subtitle}</p>

      <ul className="mt-4 space-y-1">
        {expected.map((stepName) => (
          <StepLine
            key={stepName}
            stepName={stepName}
            row={stepByName.get(stepName)}
            expanded={!!expanded[stepName]}
            onToggle={() => toggleExpanded(stepName)}
          />
        ))}
        {unknown.length > 0 ? (
          <>
            <li className="pt-2 text-[10px] font-medium uppercase tracking-wide text-gray-400">
              Additional steps
            </li>
            {unknown.map((r) => (
              <StepLine
                key={r.step + r.startedAt}
                stepName={r.step}
                row={r}
                expanded={!!expanded[r.step]}
                onToggle={() => toggleExpanded(r.step)}
              />
            ))}
          </>
        ) : null}
      </ul>

      {error ? (
        <p className="mt-3 text-xs text-amber-600">{error}</p>
      ) : null}
    </div>
  );
}

// ─── One step row ────────────────────────────────────────────────────────────

interface StepLineProps {
  stepName: string;
  row?:     StepRow;
  expanded: boolean;
  onToggle: () => void;
}

function StepLine({ stepName, row, expanded, onToggle }: StepLineProps) {
  const label = STEP_LABELS[stepName] ?? stepName;
  const status: 'pending' | 'running' | 'ok' | 'failed' =
    !row              ? 'pending'
    : row.status === 'STARTED' ? 'running'
    : row.status === 'OK'      ? 'ok'
    :                            'failed';

  // Elapsed time:
  //   running → now - startedAt (ticks via parent re-render)
  //   ok/failed → durationMs
  //   pending → nothing
  const elapsedLabel =
    status === 'running' && row
      ? `${((Date.now() - new Date(row.startedAt).getTime()) / 1000).toFixed(1)}s`
      : (status === 'ok' || status === 'failed') && row?.durationMs != null
        ? `${(row.durationMs / 1000).toFixed(1)}s`
        : null;

  const hasDetail =
    (status === 'failed' && (row?.error || row?.truncatedLog)) ||
    (status === 'ok' && row?.truncatedLog);

  return (
    <li>
      <div className="flex items-center gap-3 text-sm">
        <StatusDot status={status} />
        <span
          className={
            status === 'failed'  ? 'text-red-700 font-medium'
            : status === 'running' ? 'text-gray-900 font-medium'
            : status === 'ok'    ? 'text-gray-700'
            :                      'text-gray-400'
          }
        >
          {label}
          {status === 'running' ? '…' : ''}
        </span>
        {hasDetail ? (
          <button
            type="button"
            onClick={onToggle}
            className="text-[10px] uppercase tracking-wide text-gray-400 hover:text-gray-600 transition-colors"
          >
            {expanded ? 'hide' : 'details'}
          </button>
        ) : null}
        {elapsedLabel ? (
          <span className={`ml-auto text-xs tabular-nums ${
            status === 'running' ? 'text-gray-600' : 'text-gray-400'
          }`}>
            {elapsedLabel}
          </span>
        ) : null}
      </div>
      {hasDetail && expanded ? (
        <pre className="mt-1 ml-5 overflow-x-auto rounded-md bg-gray-50 p-2 text-[11px] leading-relaxed text-gray-700 whitespace-pre-wrap">
          {row?.error ?? row?.truncatedLog ?? ''}
        </pre>
      ) : null}
    </li>
  );
}

// ─── Status dot ──────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: 'pending' | 'running' | 'ok' | 'failed' }) {
  const cls =
    status === 'ok'       ? 'bg-green-500'
    : status === 'failed' ? 'bg-red-500'
    : status === 'running' ? 'bg-blue-500 animate-pulse'
    :                        'bg-gray-200';
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${cls}`} aria-hidden />;
}
