'use client';

import { useMemo, useState, useTransition } from 'react';
import { useForm, Controller, type FieldPath } from 'react-hook-form';
import type { Module } from '@/lib/module-source';
import { normalizeSlug } from '@/lib/slug';
import {
  startApplyAndPreview,
  type StartProvisioningInput,
  type ApplyAndPreviewActionResult,
} from '../actions';
import { ProgressPoller } from './ProgressPoller';
import { ResultCard } from './ResultCard';
import { PreviewCard } from './PreviewCard';
import {
  Field,
  TextInput,
  TextArea,
  Select,
  PrimaryButton,
  SecondaryButton,
  Stepper,
  StepShell,
} from './fields';

/**
 * Multi-step wizard for the internal onboarding tool.
 *
 * State machine:
 *   draft      → Apply & preview button → applying
 *   applying   → (automated) preview ready → previewing
 *   previewing → Approve → approving | Cancel → draft | Re-apply → draft (pre-filled)
 *   approving  → (automated) done | failed
 *   done       → ResultCard (success)
 *   failed     → ResultCard (failure) or back to draft
 */

type FlowState =
  | 'draft'
  | 'applying'
  | 'previewing'
  | 'approving'
  | 'done'
  | 'failed';

type PlanTier = 'starter' | 'pro' | 'enterprise';

type FormValues = {
  name: string;
  slug: string;
  industry?: string;
  country?: string;
  timezone: string;
  adminName: string;
  adminEmail: string;
  adminPhone?: string;
  teamGithubUsernames?: string;
  brandPrimaryColor: string;
  brandSecondaryColor?: string;
  brandLogoUrl?: string;
  brandFaviconUrl?: string;
  enabledModules: Record<string, boolean>;
  planTier: PlanTier;
  userSeats: number;
  goLiveDate?: string;
  notes?: string;
};

const STEP_FIELDS: FieldPath<FormValues>[][] = [
  ['name', 'slug', 'industry', 'country', 'timezone'],
  ['adminName', 'adminEmail', 'adminPhone', 'teamGithubUsernames'],
  ['brandPrimaryColor', 'brandSecondaryColor', 'brandLogoUrl', 'brandFaviconUrl'],
  ['enabledModules', 'planTier', 'userSeats', 'goLiveDate', 'notes'],
  [],
];

function parseUsernames(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const STEPS = [
  { key: 'client', label: 'Client' },
  { key: 'contact', label: 'Contact' },
  { key: 'branding', label: 'Branding' },
  { key: 'features', label: 'Features' },
  { key: 'review', label: 'Review' },
];

const INDUSTRIES = [
  'Retail & E-commerce',
  'SaaS & Software',
  'Healthcare',
  'Financial Services',
  'Education',
  'Manufacturing',
  'Media & Entertainment',
  'Non-profit',
  'Other',
];

const COUNTRIES = [
  'United States',
  'United Kingdom',
  'Canada',
  'Australia',
  'India',
  'Germany',
  'France',
  'Spain',
  'Netherlands',
  'Singapore',
  'Other',
];

const TIMEZONES = [
  'Etc/UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];

interface Props {
  modules: Module[];
}

export function OnboardForm({ modules }: Props) {
  const [flowState, setFlowState] = useState<FlowState>('draft');
  const [currentStep, setCurrentStep] = useState(0);
  const [provisioningId, setProvisioningId] = useState<string | null>(null);

  // Preview-phase state.
  const [previewSession, setPreviewSession] = useState<{
    sessionId: string;
    previewUrl: string;
    adminEmail: string;
    expiresAt: string;
  } | null>(null);

  // Terminal state for done/failed.
  const [terminal, setTerminal] = useState<null | {
    status: 'READY' | 'FAILED';
    repoUrl?: string;
    friendlyError?: string;
    referenceId?: string;
    warnings?: string[];
  }>(null);

  const [friendlyError, setFriendlyError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const form = useForm<FormValues>({
    mode: 'onBlur',
    defaultValues: {
      name: '',
      slug: '',
      industry: '',
      country: '',
      timezone: 'Etc/UTC',
      adminName: '',
      adminEmail: '',
      adminPhone: '',
      teamGithubUsernames: '',
      brandPrimaryColor: '#1e40af',
      brandSecondaryColor: '',
      brandLogoUrl: '',
      brandFaviconUrl: '',
      enabledModules: Object.fromEntries(modules.map((m) => [m.key, false])),
      planTier: 'starter',
      userSeats: 5,
      goLiveDate: '',
      notes: '',
    },
  });

  const {
    control,
    register,
    handleSubmit,
    watch,
    setValue,
    setError,
    trigger,
    formState: { errors },
  } = form;

  const name = watch('name');
  const [slugEdited, setSlugEdited] = useState(false);
  const derivedSlug = useMemo(() => normalizeSlug(name || ''), [name]);
  if (!slugEdited && watch('slug') !== derivedSlug) {
    setValue('slug', derivedSlug, { shouldValidate: false });
  }

  async function goNext() {
    const ok = await trigger(STEP_FIELDS[currentStep]);
    if (!ok) return;
    if (currentStep === 3) {
      const selected = Object.values(watch('enabledModules')).filter(Boolean);
      if (selected.length === 0) {
        setError('enabledModules', { message: 'Please select at least one module.' });
        return;
      }
    }
    setCurrentStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  function goBack() {
    setCurrentStep((s) => Math.max(s - 1, 0));
  }

  function buildInput(data: FormValues): StartProvisioningInput {
    return {
      provisioningId: provisioningId ?? undefined,
      name: data.name,
      slug: data.slug,
      industry: data.industry || undefined,
      country: data.country || undefined,
      timezone: data.timezone,
      adminName: data.adminName,
      adminEmail: data.adminEmail,
      adminPhone: data.adminPhone || undefined,
      teamGithubUsernames: parseUsernames(data.teamGithubUsernames),
      brandPrimaryColor: data.brandPrimaryColor,
      brandSecondaryColor: data.brandSecondaryColor || undefined,
      brandLogoUrl: data.brandLogoUrl || undefined,
      brandFaviconUrl: data.brandFaviconUrl || undefined,
      enabledModules: Object.entries(data.enabledModules)
        .filter(([, v]) => v)
        .map(([k]) => k),
      planTier: data.planTier,
      userSeats: Number(data.userSeats),
      goLiveDate: data.goLiveDate || undefined,
      notes: data.notes || undefined,
    };
  }

  function actuallySubmit(data: FormValues) {
    setFriendlyError(null);
    setTerminal(null);
    setConfirmOpen(false);

    // Generate a client-side provisioningId BEFORE calling the action so the
    // ProgressPoller can start polling immediately while the server action is
    // still running. The backend honours this id when creating the Client row
    // (see stepCreateClientRow). Format must match the /^[a-f0-9]{32}$/i regex
    // used by the status route — we strip the hyphens out of a UUID v4.
    const submissionId = provisioningId ?? crypto.randomUUID().replace(/-/g, '');
    setProvisioningId(submissionId);

    const input = buildInput({ ...data } as FormValues);
    // Override buildInput's provisioningId read (it reads from state, which
    // may not be updated yet due to React batching).
    input.provisioningId = submissionId;

    startTransition(async () => {
      setFlowState('applying');
      const result: ApplyAndPreviewActionResult = await startApplyAndPreview(input);
      if (!result.ok) {
        setFlowState('draft');
        if (result.fieldErrors) {
          for (const [key, msg] of Object.entries(result.fieldErrors)) {
            setError(key as FieldPath<FormValues>, { message: msg });
          }
        }
        if (result.friendlyError) setFriendlyError(result.friendlyError);
        return;
      }
      if (result.provisioningId) setProvisioningId(result.provisioningId);
      if (result.sessionId && result.previewUrl && result.adminEmail && result.expiresAt) {
        setPreviewSession({
          sessionId: result.sessionId,
          previewUrl: result.previewUrl,
          adminEmail: result.adminEmail,
          expiresAt: result.expiresAt,
        });
        setFlowState('previewing');
      }
    });
  }

  // Terminal: show result card.
  if (flowState === 'done' || (flowState === 'failed' && terminal)) {
    return (
      <ResultCard
        result={terminal ?? { status: 'FAILED', friendlyError: 'Unknown error.' }}
        onRetry={() => {
          setTerminal(null);
          setFlowState('draft');
          setFriendlyError(null);
          setCurrentStep(4);
        }}
        onStartFresh={() => {
          setTerminal(null);
          setFlowState('draft');
          setFriendlyError(null);
          setProvisioningId(null);
          setPreviewSession(null);
          setSlugEdited(false);
          form.reset();
          setCurrentStep(0);
        }}
      />
    );
  }

  // Approving: ProgressPoller polling the provisioningId for READY/FAILED.
  if (flowState === 'approving' && provisioningId) {
    return (
      <ProgressPoller
        provisioningId={provisioningId}
        onTerminal={(t) => {
          setTerminal(t);
          setFlowState(t.status === 'READY' ? 'done' : 'failed');
        }}
      />
    );
  }

  // Applying: the server action is in-flight via useTransition.
  // Render ProgressPoller with the client-generated provisioningId so every
  // step shows up live as the backend writes ProvisioningStepLog rows.
  if (flowState === 'applying' && provisioningId) {
    return (
      <ProgressPoller
        provisioningId={provisioningId}
        pipeline="apply"
        title="Preparing the preview…"
        subtitle="Cloning the template, applying your config, and starting the preview server. Usually 30–90 seconds."
        onTerminal={(t) => {
          // The apply phase rarely hits a READY terminal on its own — that comes
          // after approve. But if the DB ever marks this Client FAILED during
          // apply (e.g. a step threw), surface the failure here.
          if (t.status === 'FAILED') {
            setTerminal(t);
            setFlowState('failed');
          }
        }}
      />
    );
  }

  // Previewing: show the preview card.
  if (flowState === 'previewing' && previewSession) {
    const allModuleKeys = modules.map((m) => m.key);
    const enabledKeys = Object.entries(watch('enabledModules'))
      .filter(([, v]) => v)
      .map(([k]) => k);
    const disabledModules = allModuleKeys.filter((k) => !enabledKeys.includes(k));
    const clientName = watch('name');

    return (
      <PreviewCard
        sessionId={previewSession.sessionId}
        previewUrl={previewSession.previewUrl}
        adminEmail={previewSession.adminEmail}
        expiresAt={previewSession.expiresAt}
        clientName={clientName}
        disabledModules={disabledModules}
        onApproved={(repoUrl, warnings) => {
          setTerminal({ status: 'READY', repoUrl, warnings });
          setFlowState('done');
          setPreviewSession(null);
        }}
        onCancelled={() => {
          setPreviewSession(null);
          setFlowState('draft');
          setCurrentStep(4); // back to Review step
        }}
        onReApply={() => {
          setPreviewSession(null);
          setFlowState('draft');
          setCurrentStep(4); // back to Review so they can edit and resubmit
        }}
      />
    );
  }

  // Draft: wizard.
  return (
    <div className="space-y-5">
      <Stepper steps={STEPS} current={currentStep} />

      <form
        onSubmit={(e) => e.preventDefault()}
        className="rounded-xl border border-surface-border bg-white p-6 shadow-sm"
      >
        {currentStep === 0 ? (
          <StepShell
            stepIndex={0}
            stepTotal={STEPS.length}
            title="Who is this dashboard for?"
            subtitle="The basics about the client's business."
          >
            <Field label="Client name" required error={errors.name?.message}>
              <TextInput
                {...register('name', { required: 'Client name is required.' })}
                placeholder="Acme Corp"
                autoComplete="off"
              />
            </Field>

            <Field
              label="Repository slug"
              required
              hint="Used as the GitHub repo name: dashboard-<slug>. Auto-generated from the client name; edit if you need to."
              error={errors.slug?.message}
            >
              <TextInput
                {...register('slug', {
                  required: 'Slug is required.',
                  onChange: () => setSlugEdited(true),
                })}
                className="font-mono"
                placeholder="acme-corp"
                autoComplete="off"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Industry" error={errors.industry?.message}>
                <Select {...register('industry')}>
                  <option value="">Select…</option>
                  {INDUSTRIES.map((i) => (
                    <option key={i} value={i}>
                      {i}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Country" error={errors.country?.message}>
                <Select {...register('country')}>
                  <option value="">Select…</option>
                  {COUNTRIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field
              label="Timezone"
              required
              hint="Used by the template for scheduled reports and audit timestamps."
              error={errors.timezone?.message}
            >
              <Select {...register('timezone', { required: 'Pick a timezone.' })}>
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </Select>
            </Field>
          </StepShell>
        ) : null}

        {currentStep === 1 ? (
          <StepShell
            stepIndex={1}
            stepTotal={STEPS.length}
            title="Who's the main admin?"
            subtitle="The person who will receive the handover email."
          >
            <Field label="Admin full name" required error={errors.adminName?.message}>
              <TextInput
                {...register('adminName', { required: 'Admin name is required.' })}
                placeholder="Jane Doe"
                autoComplete="off"
              />
            </Field>

            <Field label="Admin email" required error={errors.adminEmail?.message}>
              <TextInput
                type="email"
                {...register('adminEmail', { required: 'Admin email is required.' })}
                placeholder="admin@acme.com"
                autoComplete="off"
              />
            </Field>

            <Field label="Admin phone" error={errors.adminPhone?.message}>
              <TextInput
                type="tel"
                {...register('adminPhone')}
                placeholder="+1 415 555 0100"
                autoComplete="off"
              />
            </Field>

            <Field
              label="Team members & client (GitHub usernames)"
              hint="Each person here will be invited as a collaborator on the new repo with push access. Separate usernames with commas — for example: alice-gh, bob-dev, client-acme. Leave blank to skip."
              error={errors.teamGithubUsernames?.message}
            >
              <TextInput
                {...register('teamGithubUsernames')}
                placeholder="alice-gh, bob-dev, client-acme"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              {(() => {
                const parsed = parseUsernames(watch('teamGithubUsernames'));
                if (parsed.length === 0) return null;
                return (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {parsed.map((u) => (
                      <span
                        key={u}
                        className="rounded-full border border-surface-border bg-surface-muted px-2 py-0.5 text-xs font-mono text-gray-700"
                      >
                        @{u}
                      </span>
                    ))}
                    <span className="text-xs text-gray-500">
                      {parsed.length} {parsed.length === 1 ? 'invite' : 'invites'} will be sent
                    </span>
                  </div>
                );
              })()}
            </Field>
          </StepShell>
        ) : null}

        {currentStep === 2 ? (
          <StepShell
            stepIndex={2}
            stepTotal={STEPS.length}
            title="How should it look?"
            subtitle="Brand colors and assets used across the client dashboard."
          >
            <Field
              label="Primary brand color"
              required
              hint="Used for headers, buttons, and highlights."
              error={errors.brandPrimaryColor?.message}
            >
              <Controller
                name="brandPrimaryColor"
                control={control}
                rules={{ required: 'Pick a brand color.' }}
                render={({ field }) => (
                  <div className="flex items-center gap-3">
                    <input
                      type="color"
                      value={field.value}
                      onChange={field.onChange}
                      className="h-10 w-14 cursor-pointer rounded border border-surface-border"
                      aria-label="Primary brand color picker"
                    />
                    <TextInput
                      value={field.value}
                      onChange={field.onChange}
                      className="w-32 font-mono"
                    />
                  </div>
                )}
              />
            </Field>

            <Field
              label="Secondary brand color"
              hint="Optional — used for accents."
              error={errors.brandSecondaryColor?.message}
            >
              <Controller
                name="brandSecondaryColor"
                control={control}
                render={({ field }) => (
                  <div className="flex items-center gap-3">
                    <input
                      type="color"
                      value={field.value || '#94a3b8'}
                      onChange={field.onChange}
                      className="h-10 w-14 cursor-pointer rounded border border-surface-border"
                      aria-label="Secondary brand color picker"
                    />
                    <TextInput
                      value={field.value || ''}
                      onChange={field.onChange}
                      placeholder="#94a3b8"
                      className="w-32 font-mono"
                    />
                  </div>
                )}
              />
            </Field>

            <Field label="Logo URL" error={errors.brandLogoUrl?.message}>
              <TextInput
                type="url"
                {...register('brandLogoUrl')}
                placeholder="https://cdn.acme.com/logo.svg"
              />
            </Field>

            <Field label="Favicon URL" error={errors.brandFaviconUrl?.message}>
              <TextInput
                type="url"
                {...register('brandFaviconUrl')}
                placeholder="https://cdn.acme.com/favicon.ico"
              />
            </Field>
          </StepShell>
        ) : null}

        {currentStep === 3 ? (
          <StepShell
            stepIndex={3}
            stepTotal={STEPS.length}
            title="What's included?"
            subtitle="Pick the modules and plan for this client."
          >
            <Field
              label="Modules"
              required
              hint="At least one is required. Dashboard is always included."
              error={errors.enabledModules?.message as string | undefined}
            >
              <div className="space-y-2">
                {modules.map((m) => (
                  <label
                    key={m.key}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border border-surface-border p-3 hover:bg-surface-muted"
                  >
                    <input
                      type="checkbox"
                      {...register(`enabledModules.${m.key}` as const)}
                      className="mt-0.5 h-4 w-4"
                    />
                    <div>
                      <div className="text-sm font-medium">{m.displayName}</div>
                      <div className="text-xs text-gray-500">{m.description}</div>
                    </div>
                  </label>
                ))}
              </div>
            </Field>

            <Field
              label="Go-live date"
              hint="Target date to hand the dashboard over to the client."
              error={errors.goLiveDate?.message}
            >
              <TextInput type="date" {...register('goLiveDate')} />
            </Field>

            <Field label="Internal notes" error={errors.notes?.message}>
              <TextArea
                {...register('notes')}
                rows={3}
                placeholder="Why you're provisioning this dashboard. Visible to staff only."
              />
            </Field>
          </StepShell>
        ) : null}

        {currentStep === 4 ? (
          <StepShell
            stepIndex={4}
            stepTotal={STEPS.length}
            title="Does this look right?"
            subtitle="Review the details, then click Apply & preview to see the dashboard before creating the repo."
          >
            <ReviewSummary values={watch()} modules={modules} />
            {friendlyError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
                {friendlyError}
              </div>
            ) : null}
          </StepShell>
        ) : null}

        <div className="mt-8 flex items-center justify-between gap-3 border-t border-surface-border pt-5">
          <SecondaryButton
            type="button"
            onClick={goBack}
            disabled={currentStep === 0 || pending}
          >
            Back
          </SecondaryButton>

          {currentStep < STEPS.length - 1 ? (
            <PrimaryButton type="button" onClick={goNext} disabled={pending}>
              Next
            </PrimaryButton>
          ) : (
            <PrimaryButton
              type="button"
              onClick={() => setConfirmOpen(true)}
              disabled={pending}
            >
              {pending ? 'Working…' : 'Apply & preview'}
            </PrimaryButton>
          )}
        </div>
      </form>

      {confirmOpen ? (
        <ConfirmModal
          name={watch('name')}
          slug={watch('slug')}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={handleSubmit(actuallySubmit)}
        />
      ) : null}
    </div>
  );
}

function ReviewSummary({ values, modules }: { values: FormValues; modules: Module[] }) {
  const selectedModules = modules.filter((m) => values.enabledModules[m.key]);
  const rows: [string, React.ReactNode][] = [
    ['Client name', values.name || '—'],
    ['Repository', `dashboard-${values.slug || '…'}`],
    ['Industry', values.industry || '—'],
    ['Country', values.country || '—'],
    ['Timezone', values.timezone],
    ['Admin', `${values.adminName || '—'} <${values.adminEmail || '—'}>`],
    ['Admin phone', values.adminPhone || '—'],
    [
      'Team members',
      (() => {
        const usernames = parseUsernames(values.teamGithubUsernames);
        if (usernames.length === 0) return '—';
        return (
          <span key="team" className="flex flex-wrap items-center gap-1.5">
            {usernames.map((u) => (
              <span
                key={u}
                className="rounded-full border border-surface-border bg-surface-muted px-2 py-0.5 font-mono text-xs"
              >
                @{u}
              </span>
            ))}
            <span className="text-xs text-gray-500">· invited as push collaborators</span>
          </span>
        );
      })(),
    ],
    [
      'Brand colors',
      <span key="colors" className="flex items-center gap-2">
        <span
          className="inline-block h-4 w-4 rounded border border-surface-border"
          style={{ backgroundColor: values.brandPrimaryColor }}
        />
        <code className="font-mono text-xs">{values.brandPrimaryColor}</code>
        {values.brandSecondaryColor ? (
          <>
            <span
              className="inline-block h-4 w-4 rounded border border-surface-border"
              style={{ backgroundColor: values.brandSecondaryColor }}
            />
            <code className="font-mono text-xs">{values.brandSecondaryColor}</code>
          </>
        ) : null}
      </span>,
    ],
    ['Logo', values.brandLogoUrl || '—'],
    ['Favicon', values.brandFaviconUrl || '—'],
    ['Plan', `${values.planTier} · ${values.userSeats} seats`],
    ['Go-live', values.goLiveDate || '—'],
    [
      'Modules',
      selectedModules.length === 0
        ? '—'
        : selectedModules.map((m) => m.displayName).join(', '),
    ],
    ['Notes', values.notes || '—'],
  ];
  return (
    <dl className="divide-y divide-surface-border rounded-lg border border-surface-border bg-surface-muted/50">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-start gap-4 px-4 py-3 text-sm">
          <dt className="w-32 shrink-0 font-medium text-gray-500">{label}</dt>
          <dd className="min-w-0 flex-1 break-words text-gray-900">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ConfirmModal({
  name,
  slug,
  onCancel,
  onConfirm,
}: {
  name: string;
  slug: string;
  onCancel: () => void;
  onConfirm: () => void;
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
        <h2 className="text-lg font-semibold">Apply & preview this dashboard?</h2>
        <p className="mt-2 text-sm text-gray-600">
          We will clone the template, apply your configuration for <strong>{name}</strong>, and
          start a local preview server so you can verify it before creating any GitHub repository.
        </p>
        <p className="mt-1.5 text-sm text-gray-600">
          The repository name will be{' '}
          <code className="font-mono text-xs">dashboard-{slug}</code>.
          No GitHub repo is created until you click Approve in the next step.
        </p>
        <div className="mt-5 flex gap-3">
          <SecondaryButton type="button" onClick={onCancel} className="flex-1">
            Cancel
          </SecondaryButton>
          <PrimaryButton type="button" onClick={onConfirm} className="flex-1">
            Apply & preview
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
