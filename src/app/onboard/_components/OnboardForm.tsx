'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useForm, Controller, type FieldPath } from 'react-hook-form';
import type { Module } from '@/lib/module-source';
import { normalizeSlug } from '@/lib/slug';
import {
  startApplyAndPreview,
  type StartProvisioningInput,
  type ApplyAndPreviewActionResult,
  type IntegrationHandoff,
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
type DashboardType = 'custom' | 'middleware' | 'saas';
type SidebarTheme = 'navy' | 'zoho' | 'slate' | 'neutral';

/**
 * Sidebar palette swatches shown on the Branding step.
 * Hex values here are for the preview swatch ONLY — the actual runtime palette
 * lives in the template (components/shell/sidebar-themes.ts). If you tweak the
 * template colors, update these hex values to match.
 */
const SIDEBAR_THEME_OPTIONS: Array<{
  key: SidebarTheme;
  label: string;
  tagline: string;
  bg: string;
  border: string;
  accent: string;
}> = [
  { key: 'navy',    label: 'Navy',    tagline: 'Stripe-style deep navy',    bg: '#0B1A2E', border: '#1B2D47', accent: '#1B2D47' },
  { key: 'zoho',    label: 'Zoho',    tagline: 'Gunmetal blue',             bg: '#1C2836', border: '#2B3B4D', accent: '#2B3B4D' },
  { key: 'slate',   label: 'Slate',   tagline: 'Linear / Vercel slate-900', bg: '#0F172A', border: '#1E293B', accent: '#1E293B' },
  { key: 'neutral', label: 'Neutral', tagline: 'GitHub / Notion pure black',bg: '#0A0A0A', border: '#262626', accent: '#262626' },
];

type SyncTargets = { products: boolean; orders: boolean; customers: boolean };

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
  sidebarTheme: SidebarTheme;
  dashboardType: DashboardType;
  integrationType: 'shopify' | 'bigcommerce' | 'none';
  enabledModules: Record<string, boolean>;
  planTier: PlanTier;
  userSeats: number;
  goLiveDate?: string;
  notes?: string;
};

const STEP_FIELDS: FieldPath<FormValues>[][] = [
  ['name', 'slug', 'industry', 'country', 'timezone'],
  ['adminName', 'adminEmail', 'adminPhone', 'teamGithubUsernames'],
  ['brandPrimaryColor', 'brandSecondaryColor', 'brandLogoUrl', 'brandFaviconUrl', 'sidebarTheme'],
  ['dashboardType'],
  ['integrationType'],
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
  { key: 'dashboard-type', label: 'Dashboard' },
  { key: 'integrations', label: 'Integrations' },
  { key: 'features', label: 'Features' },
  { key: 'review', label: 'Review' },
];

// Zero-based step indices so the code below stays readable.
const STEP_CLIENT = 0;
const STEP_CONTACT = 1;
const STEP_BRANDING = 2;
const STEP_DASHBOARD_TYPE = 3;
const STEP_INTEGRATIONS = 4;
const STEP_FEATURES = 5;
const STEP_REVIEW = 6;

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

const DRAFT_STORAGE_KEY = 'onboard-form-draft-v1';

type PersistedDraft = {
  values: FormValues;
  currentStep: number;
  slugEdited: boolean;
};

function loadDraft(): PersistedDraft | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedDraft;
    if (!parsed || typeof parsed !== 'object' || !parsed.values) return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearDraft() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

export function OnboardForm({ modules }: Props) {
  // Hydration-safe draft restoration: we MUST render the same tree on the
  // server and on the first client render, otherwise React throws a hydration
  // mismatch. So we always start at step 0 with empty defaults, then — once
  // mounted — read localStorage and restore the saved step + values.
  const [hydrated, setHydrated] = useState(false);

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

  // One-time integration handoff returned by the server action for
  // middleware dashboards. Lives in memory only; cleared on Start Fresh.
  const [integrationHandoff, setIntegrationHandoff] = useState<IntegrationHandoff | null>(null);

  // Terminal state for done/failed.
  const [terminal, setTerminal] = useState<null | {
    status: 'READY' | 'FAILED';
    repoUrl?: string;
    friendlyError?: string;
    referenceId?: string;
    warnings?: string[];
    integrationHandoff?: IntegrationHandoff;
  }>(null);

  const [friendlyError, setFriendlyError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const emptyDefaults: FormValues = {
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
    sidebarTheme: 'navy',
    dashboardType: 'custom',
    integrationType: 'none',
    enabledModules: Object.fromEntries(modules.map((m) => [m.key, false])),
    planTier: 'starter',
    userSeats: 5,
    goLiveDate: '',
    notes: '',
  };

  const form = useForm<FormValues>({
    mode: 'onBlur',
    defaultValues: emptyDefaults,
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

  // Restore any saved draft after mount. Doing this in an effect (not during
  // render) avoids a server/client hydration mismatch — the first render on
  // both sides uses emptyDefaults + step 0, then the client repopulates.
  useEffect(() => {
    const draft = loadDraft();
    if (draft) {
      form.reset({
        ...(draft.values as FormValues),
        enabledModules: {
          ...Object.fromEntries(modules.map((m) => [m.key, false])),
          ...(draft.values?.enabledModules ?? {}),
        },
      });
      setCurrentStep(
        Math.min(Math.max(draft.currentStep ?? 0, 0), STEPS.length - 1),
      );
      setSlugEdited(Boolean(draft.slugEdited));
    }
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist form values + current step to localStorage on every change, so a
  // page refresh lands the user back on the step they were on with the data
  // they had entered. Cleared on successful submit or Start Fresh. Guarded by
  // `hydrated` so the initial empty render doesn't overwrite the saved draft
  // before we've had a chance to read it back.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!hydrated) return;
    const sub = form.watch((values) => {
      try {
        const payload: PersistedDraft = {
          values: values as FormValues,
          currentStep,
          slugEdited,
        };
        window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(payload));
      } catch {
        // ignore storage errors (quota, disabled storage, etc.)
      }
    });
    // Also save immediately so step/slugEdited changes persist without waiting
    // for a form value change.
    try {
      const payload: PersistedDraft = {
        values: form.getValues(),
        currentStep,
        slugEdited,
      };
      window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore
    }
    return () => sub.unsubscribe();
  }, [form, currentStep, slugEdited, hydrated]);
  const derivedSlug = useMemo(() => normalizeSlug(name || ''), [name]);
  if (!slugEdited && watch('slug') !== derivedSlug) {
    setValue('slug', derivedSlug, { shouldValidate: false });
  }

  async function goNext() {
    const ok = await trigger(STEP_FIELDS[currentStep]);
    if (!ok) return;
    if (currentStep === STEP_DASHBOARD_TYPE) {
      const dt = watch('dashboardType');
      if (dt === 'saas') {
        setError('dashboardType', {
          message: 'SaaS dashboards are coming soon. Pick Custom or Middleware.',
        });
        return;
      }
    }
    if (currentStep === STEP_INTEGRATIONS) {
      const integrationType = watch('integrationType');
      if (integrationType === 'none') {
        setError('integrationType', {
          message: 'Please select an integration type (Shopify or BigCommerce).',
        });
        return;
      }
    }
    if (currentStep === STEP_FEATURES) {
      const selected = Object.values(watch('enabledModules')).filter(Boolean);
      if (selected.length === 0) {
        setError('enabledModules', { message: 'Please select at least one module.' });
        return;
      }
    }
    // Skip Integrations step entirely when dashboardType !== 'middleware'.
    let next = currentStep + 1;
    if (next === STEP_INTEGRATIONS && watch('dashboardType') !== 'middleware') {
      next = STEP_FEATURES;
    }
    setCurrentStep(Math.min(next, STEPS.length - 1));
  }

  function goBack() {
    let prev = currentStep - 1;
    if (prev === STEP_INTEGRATIONS && watch('dashboardType') !== 'middleware') {
      prev = STEP_DASHBOARD_TYPE;
    }
    setCurrentStep(Math.max(prev, 0));
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
      sidebarTheme: data.sidebarTheme,
      dashboardType: data.dashboardType,
      integrations: {
        shopify: {
          enabled: data.integrationType === 'shopify',
          storeUrl: undefined,
          accessToken: undefined,
          webhookSecret: undefined,
          sync: { products: true, orders: true, customers: false },
        },
        bigcommerce: {
          enabled: data.integrationType === 'bigcommerce',
          storeHash: undefined,
          accessToken: undefined,
          clientId: undefined,
          sync: { products: true, orders: true, customers: false },
        },
      },
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
        const knownFormPaths = new Set<string>([
          'name', 'slug', 'industry', 'country', 'timezone',
          'adminName', 'adminEmail', 'adminPhone', 'teamGithubUsernames',
          'brandPrimaryColor', 'brandSecondaryColor', 'brandLogoUrl', 'brandFaviconUrl', 'sidebarTheme',
          'dashboardType', 'integrationType',
          'enabledModules', 'planTier', 'userSeats', 'goLiveDate', 'notes',
        ]);
        const unmapped: string[] = [];
        if (result.fieldErrors) {
          for (const [key, msg] of Object.entries(result.fieldErrors)) {
            if (knownFormPaths.has(key)) {
              setError(key as FieldPath<FormValues>, { message: msg });
            } else {
              unmapped.push(`${key}: ${msg}`);
            }
          }
        }
        if (result.friendlyError) {
          setFriendlyError(result.friendlyError);
        } else if (unmapped.length > 0) {
          setFriendlyError(unmapped.join(' · '));
        } else if (result.fieldErrors && Object.keys(result.fieldErrors).length > 0) {
          setFriendlyError('Some fields need attention — scroll back through the steps to review.');
        }
        return;
      }
      if (result.provisioningId) setProvisioningId(result.provisioningId);
      if (result.integrationHandoff) setIntegrationHandoff(result.integrationHandoff);
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
          setIntegrationHandoff(null);
          setSlugEdited(false);
          form.reset();
          setCurrentStep(0);
          clearDraft();
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
          setTerminal({
            status: 'READY',
            repoUrl,
            warnings,
            ...(integrationHandoff ? { integrationHandoff } : {}),
          });
          setFlowState('done');
          setPreviewSession(null);
          setIntegrationHandoff(null);
          clearDraft();
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

            <Field
              label="Sidebar theme"
              required
              hint="Dark palette applied only to the sidebar. The rest of the app stays light."
              error={errors.sidebarTheme?.message}
            >
              <Controller
                name="sidebarTheme"
                control={control}
                render={({ field }) => (
                  <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
                    {SIDEBAR_THEME_OPTIONS.map((opt) => (
                      <SidebarThemeCard
                        key={opt.key}
                        option={opt}
                        selected={field.value === opt.key}
                        onSelect={() => field.onChange(opt.key)}
                      />
                    ))}
                  </div>
                )}
              />
            </Field>
          </StepShell>
        ) : null}

        {currentStep === STEP_DASHBOARD_TYPE ? (
          <StepShell
            stepIndex={STEP_DASHBOARD_TYPE}
            stepTotal={STEPS.length}
            title="What kind of dashboard is this?"
            subtitle="Pick how this client's dashboard will be set up."
          >
            <Controller
              name="dashboardType"
              control={control}
              render={({ field }) => (
                <div className="grid gap-3 sm:grid-cols-3">
                  <DashboardTypeCard
                    value="custom"
                    selected={field.value === 'custom'}
                    onSelect={() => field.onChange('custom')}
                    title="Custom"
                    description="Standalone dashboard with users, roles, logs, and settings. No external commerce integration."
                  />
                  <DashboardTypeCard
                    value="middleware"
                    selected={field.value === 'middleware'}
                    onSelect={() => field.onChange('middleware')}
                    title="Middleware"
                    description="Connects to Shopify and/or BigCommerce. Syncs products, orders, and customers."
                    badge="Shopify · BigCommerce"
                  />
                  <DashboardTypeCard
                    value="saas"
                    selected={field.value === 'saas'}
                    onSelect={() => {}}
                    disabled
                    title="SaaS"
                    description="Multi-tenant hosted dashboard we run centrally. Not yet available."
                    badge="Coming soon"
                  />
                </div>
              )}
            />
            {errors.dashboardType?.message ? (
              <p className="mt-2 text-sm text-red-700">{errors.dashboardType.message}</p>
            ) : null}
          </StepShell>
        ) : null}

        {currentStep === STEP_INTEGRATIONS ? (
          <StepShell
            stepIndex={STEP_INTEGRATIONS}
            stepTotal={STEPS.length}
            title="Select integration type"
            subtitle="Choose which commerce platform this dashboard will connect to."
          >
            <Field
              label="Integration type"
              required
              hint="Select the platform the client uses for their online store."
              error={errors.integrationType?.message}
            >
              <div className="space-y-3">
                <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-surface-border p-4 hover:bg-surface-muted">
                  <input
                    type="radio"
                    value="shopify"
                    {...register('integrationType')}
                    className="h-4 w-4"
                  />
                  <div>
                    <div className="text-sm font-medium">Shopify</div>
                    <div className="text-xs text-gray-500">Connect to a Shopify store</div>
                  </div>
                </label>
                <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-surface-border p-4 hover:bg-surface-muted">
                  <input
                    type="radio"
                    value="bigcommerce"
                    {...register('integrationType')}
                    className="h-4 w-4"
                  />
                  <div>
                    <div className="text-sm font-medium">BigCommerce</div>
                    <div className="text-xs text-gray-500">Connect to a BigCommerce store</div>
                  </div>
                </label>
              </div>
            </Field>
          </StepShell>
        ) : null}

        {currentStep === STEP_FEATURES ? (
          <StepShell
            stepIndex={STEP_FEATURES}
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
              <div className="grid gap-2 sm:grid-cols-2">
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

        {currentStep === STEP_REVIEW ? (
          <StepShell
            stepIndex={STEP_REVIEW}
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
    [
      'Sidebar theme',
      (() => {
        const opt = SIDEBAR_THEME_OPTIONS.find((o) => o.key === values.sidebarTheme);
        if (!opt) return values.sidebarTheme;
        return (
          <span key="sidebar-theme" className="flex items-center gap-2">
            <span
              className="inline-block h-4 w-4 rounded border border-surface-border"
              style={{ backgroundColor: opt.bg }}
            />
            <span>{opt.label}</span>
            <span className="text-xs text-gray-500">· {opt.tagline}</span>
          </span>
        );
      })(),
    ],
    [
      'Dashboard type',
      (() => {
        if (values.dashboardType === 'custom') return 'Custom';
        if (values.dashboardType === 'saas') return 'SaaS (coming soon)';
        const platform =
          values.integrationType === 'shopify'
            ? 'Shopify'
            : values.integrationType === 'bigcommerce'
              ? 'BigCommerce'
              : 'no platform selected';
        return `Middleware · ${platform}`;
      })(),
    ],
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

function DashboardTypeCard({
  title,
  description,
  selected,
  onSelect,
  badge,
  disabled,
}: {
  value: DashboardType;
  title: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
  badge?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onSelect}
      aria-pressed={selected}
      aria-disabled={disabled}
      disabled={disabled}
      className={
        'flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition ' +
        (disabled
          ? 'cursor-not-allowed border-surface-border bg-surface-muted/50 opacity-60'
          : selected
            ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200'
            : 'border-surface-border bg-white hover:border-blue-300 hover:bg-blue-50/40')
      }
    >
      <div className="flex w-full items-center justify-between">
        <span className="text-sm font-semibold text-gray-900">{title}</span>
        {badge ? (
          <span
            className={
              'rounded-full px-2 py-0.5 text-[10px] font-medium ' +
              (disabled
                ? 'bg-gray-200 text-gray-600'
                : 'bg-blue-100 text-blue-800')
            }
          >
            {badge}
          </span>
        ) : null}
      </div>
      <p className="text-xs leading-relaxed text-gray-600">{description}</p>
    </button>
  );
}

function SidebarThemeCard({
  option,
  selected,
  onSelect,
}: {
  option: (typeof SIDEBAR_THEME_OPTIONS)[number];
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={
        'group flex flex-col items-stretch gap-2 rounded-xl border p-2 text-left transition ' +
        (selected
          ? 'border-blue-500 ring-2 ring-blue-200'
          : 'border-surface-border hover:border-blue-300')
      }
    >
      {/* Mini sidebar mock — solid bg with two thin border stripes as "rows". */}
      <div
        className="h-20 w-full rounded-md relative overflow-hidden"
        style={{ backgroundColor: option.bg }}
      >
        <div
          className="absolute left-2 right-2 top-3 h-2 rounded-sm"
          style={{ backgroundColor: option.accent, opacity: 0.9 }}
        />
        <div
          className="absolute left-2 right-4 top-7 h-1.5 rounded-sm"
          style={{ backgroundColor: option.border }}
        />
        <div
          className="absolute left-2 right-6 top-10 h-1.5 rounded-sm"
          style={{ backgroundColor: option.border }}
        />
        <div
          className="absolute left-2 right-5 top-13 h-1.5 rounded-sm"
          style={{ backgroundColor: option.border, top: '3.25rem' }}
        />
      </div>
      <div className="px-0.5">
        <div className="text-xs font-semibold text-gray-900">{option.label}</div>
        <div className="text-[10px] leading-tight text-gray-500">{option.tagline}</div>
      </div>
    </button>
  );
}

function PlatformPanel({
  title,
  description,
  enabled,
  onToggle,
  children,
}: {
  platform: 'shopify' | 'bigcommerce';
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-surface-border bg-white">
      <label className="flex cursor-pointer items-start gap-3 p-4">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          className="mt-0.5 h-4 w-4"
        />
        <div className="flex-1">
          <div className="text-sm font-semibold text-gray-900">{title}</div>
          <div className="text-xs text-gray-500">{description}</div>
        </div>
      </label>
      {enabled ? (
        <div className="space-y-4 border-t border-surface-border p-4">{children}</div>
      ) : null}
    </div>
  );
}

function SyncToggles({
  namePrefix,
  register,
  watch,
}: {
  namePrefix: `integrations.${'shopify' | 'bigcommerce'}.sync`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  watch: any;
}) {
  const targets: Array<{ key: keyof SyncTargets; label: string }> = [
    { key: 'products', label: 'Products' },
    { key: 'orders', label: 'Orders' },
    { key: 'customers', label: 'Customers' },
  ];
  return (
    <Field label="Initial sync" hint="Which collections to pull from the store on first run.">
      <div className="flex flex-wrap gap-2">
        {targets.map((t) => {
          const checked = !!watch(`${namePrefix}.${t.key}`);
          return (
            <label
              key={t.key}
              className={
                'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ' +
                (checked
                  ? 'border-blue-500 bg-blue-50 text-blue-900'
                  : 'border-surface-border bg-white text-gray-700 hover:bg-surface-muted')
              }
            >
              <input
                type="checkbox"
                {...register(`${namePrefix}.${t.key}`)}
                className="h-4 w-4"
              />
              {t.label}
            </label>
          );
        })}
      </div>
    </Field>
  );
}
