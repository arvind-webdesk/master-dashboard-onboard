'use server';

import { z } from 'zod';
import { auth } from '@/lib/auth';
import { ProvisioningService, type ApplyAndPreviewResult } from '@/services/ProvisioningService';
import { normalizeSlug, isValidSlug } from '@/lib/slug';

/**
 * Server actions for the onboarding flow.
 *
 * startApplyAndPreview — Phase A–C: validate + clone + apply:config + typecheck + start preview.
 *                        Returns preview session payload. NO GitHub side effects.
 * approveProvisioning  — Phase D: kill preview, create repo, push.
 * cancelProvisioning   — Phase E: kill preview, wipe tmp dir.
 * startProvisioning    — kept for backwards-compat / headless scripts. Calls create() which
 *                        wraps applyAndPreview + approve immediately.
 *
 * Next.js server actions are CSRF-protected by same-origin check when invoked
 * through the `action` prop on a React form — we rely on that rather than
 * exposing a bare JSON API route.
 */

const emptyToUndef = (v: unknown) => (v === '' ? undefined : v);

/**
 * Strip integrations data when the client isn't picking a middleware dashboard.
 * Prevents stale form state (e.g. user toggled Shopify on while exploring, then
 * switched to Custom) from tripping integrations validation on an unrelated step.
 */
function stripIntegrationsIfNotMiddleware<T extends { dashboardType?: unknown; integrations?: unknown }>(
  input: T,
): T {
  if (input.dashboardType === 'middleware') return input;
  const emptySync = { products: false, orders: false, customers: false };
  return {
    ...input,
    integrations: {
      shopify: { enabled: false, sync: emptySync },
      bigcommerce: { enabled: false, sync: emptySync },
    },
  } as T;
}

const optionalString = z.preprocess(emptyToUndef, z.string().optional());
const optionalUrl = z.preprocess(
  emptyToUndef,
  z.string().url('Please enter a full URL (including https://).').optional(),
);
const optionalHexColor = z.preprocess(
  emptyToUndef,
  z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Pick a valid hex color.').optional(),
);

const onboardFormSchema = z.object({
  provisioningId: z.string().optional(),

  name: z.string().min(1, 'Client name is required.').max(100),
  slug: z
    .string()
    .min(3, 'Slug must be at least 3 characters.')
    .max(40, 'Slug must be 40 characters or fewer.')
    .regex(/^[a-z0-9-]+$/, 'Slug may only contain lowercase letters, numbers, and hyphens.'),
  industry: optionalString,
  country: optionalString,
  timezone: z.string().min(1, 'Please pick a timezone.'),

  adminName: z.string().min(1, 'Admin name is required.').max(120),
  adminEmail: z.string().email('Please enter a valid email address.'),
  adminPhone: optionalString,
  teamGithubUsernames: z.preprocess(
    (v) => {
      if (Array.isArray(v)) {
        return v.map((s) => String(s).trim()).filter(Boolean);
      }
      if (typeof v === 'string') {
        return v
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
      return [];
    },
    z
      .array(
        z
          .string()
          .regex(
            /^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/,
            'Enter valid GitHub usernames (letters, numbers, single hyphens, max 39 chars each).',
          ),
      )
      .max(20, 'Up to 20 usernames per provision. Use a GitHub team if you need more.'),
  ),

  brandPrimaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Pick a brand color.'),
  brandSecondaryColor: optionalHexColor,
  brandLogoUrl: optionalUrl,
  brandFaviconUrl: optionalUrl,
  /** Sidebar palette preset — must match template's SidebarTheme union. */
  sidebarTheme: z.enum(['navy', 'zoho', 'slate', 'neutral']).default('navy'),

  dashboardType: z.enum(['custom', 'middleware', 'saas']),
  integrations: z
    .object({
      shopify: z.object({
        enabled: z.boolean(),
        storeUrl: z.preprocess(
          emptyToUndef,
          z
            .string()
            .regex(
              /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i,
              'Enter the .myshopify.com domain (e.g. acme.myshopify.com).',
            )
            .optional(),
        ),
        accessToken: z.preprocess(
          emptyToUndef,
          z.string().min(10, 'Access token looks too short.').optional(),
        ),
        webhookSecret: z.preprocess(emptyToUndef, z.string().optional()),
        sync: z.object({
          products: z.boolean(),
          orders: z.boolean(),
          customers: z.boolean(),
        }),
      }),
      bigcommerce: z.object({
        enabled: z.boolean(),
        storeHash: z.preprocess(
          emptyToUndef,
          z
            .string()
            .regex(/^[a-z0-9]{6,16}$/i, 'Store hash is the short alphanumeric string from your store URL.')
            .optional(),
        ),
        accessToken: z.preprocess(
          emptyToUndef,
          z.string().min(10, 'Access token looks too short.').optional(),
        ),
        clientId: z.preprocess(emptyToUndef, z.string().optional()),
        sync: z.object({
          products: z.boolean(),
          orders: z.boolean(),
          customers: z.boolean(),
        }),
      }),
    })
    .superRefine((val, ctx) => {
      if (val.shopify.enabled) {
        if (!val.shopify.storeUrl)
          ctx.addIssue({
            code: 'custom',
            path: ['shopify', 'storeUrl'],
            message: 'Shopify store URL is required.',
          });
        if (!val.shopify.accessToken)
          ctx.addIssue({
            code: 'custom',
            path: ['shopify', 'accessToken'],
            message: 'Shopify Admin API access token is required.',
          });
      }
      if (val.bigcommerce.enabled) {
        if (!val.bigcommerce.storeHash)
          ctx.addIssue({
            code: 'custom',
            path: ['bigcommerce', 'storeHash'],
            message: 'BigCommerce store hash is required.',
          });
        if (!val.bigcommerce.accessToken)
          ctx.addIssue({
            code: 'custom',
            path: ['bigcommerce', 'accessToken'],
            message: 'BigCommerce API access token is required.',
          });
      }
    }),

  enabledModules: z.array(z.string().min(1)).min(1, 'Please select at least one module.'),
  planTier: z.enum(['starter', 'pro', 'enterprise']),
  userSeats: z
    .number({ invalid_type_error: 'Please enter a number of seats.' })
    .int('Seats must be a whole number.')
    .min(1, 'At least 1 seat is required.')
    .max(10000, 'That is a lot of seats — double-check the number.'),
  goLiveDate: optionalString,
  notes: z.preprocess(
    emptyToUndef,
    z.string().max(1000, 'Notes are too long (max 1000 characters).').optional(),
  ),
}).superRefine((val, ctx) => {
  if (val.dashboardType === 'saas') {
    ctx.addIssue({
      code: 'custom',
      path: ['dashboardType'],
      message: 'The SaaS dashboard is coming soon. Pick Custom or Middleware for now.',
    });
  }
  if (val.dashboardType === 'middleware') {
    if (!val.integrations.shopify.enabled && !val.integrations.bigcommerce.enabled) {
      ctx.addIssue({
        code: 'custom',
        path: ['integrations'],
        message: 'Middleware dashboards need at least one platform enabled.',
      });
    }
  }
});

export type StartProvisioningInput = z.infer<typeof onboardFormSchema>;

export interface StartProvisioningResult {
  ok: boolean;
  provisioningId?: string;
  fieldErrors?: Record<string, string>;
  friendlyError?: string;
}

/**
 * Echo of integration secrets collected by the form. Returned from the server
 * action ONLY on the success path so the ResultCard can present them as a
 * one-time handoff for the client's own `.env`. These values never touch
 * Prisma, never land in seed-data.json, never enter git. They live in RAM
 * (staff browser + this action's response) and are discarded after display.
 */
export interface IntegrationHandoff {
  shopify?: { storeUrl: string; accessToken: string; webhookSecret?: string };
  bigcommerce?: { storeHash: string; accessToken: string; clientId?: string };
}

export interface ApplyAndPreviewActionResult {
  ok: boolean;
  sessionId?: string;
  provisioningId?: string;
  previewUrl?: string;
  adminEmail?: string;
  expiresAt?: string;
  integrationHandoff?: IntegrationHandoff;
  fieldErrors?: Record<string, string>;
  friendlyError?: string;
}

export interface ApproveActionResult {
  ok: boolean;
  repoUrl?: string;
  warnings?: string[];
  friendlyError?: string;
  referenceId?: string;
}

// ─── startApplyAndPreview ─────────────────────────────────────────────────────

/**
 * Phase A–C. Clones the template, applies config, typechecks, starts the
 * preview dev server. Returns the preview URL + sessionId for staff to inspect.
 * NO GitHub repo is created here.
 */
export async function startApplyAndPreview(
  input: StartProvisioningInput,
): Promise<ApplyAndPreviewActionResult> {
  const session = await auth();
  const login = (session?.user as { login?: string } | undefined)?.login;
  if (!session?.user || !login) {
    return { ok: false, friendlyError: 'Your session has expired. Please sign in again.' };
  }

  const normalized: StartProvisioningInput = stripIntegrationsIfNotMiddleware({
    ...input,
    slug: isValidSlug(input.slug) ? input.slug : normalizeSlug(input.slug),
  });

  const parsed = onboardFormSchema.safeParse(normalized);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.');
      if (!fieldErrors[path]) fieldErrors[path] = issue.message;
    }
    return { ok: false, fieldErrors };
  }

  try {
    const service = new ProvisioningService();
    const result: ApplyAndPreviewResult = await service.applyAndPreview({
      provisioningId: parsed.data.provisioningId,
      name: parsed.data.name,
      slug: parsed.data.slug,
      industry: parsed.data.industry ?? null,
      country: parsed.data.country ?? null,
      timezone: parsed.data.timezone,
      adminName: parsed.data.adminName,
      adminEmail: parsed.data.adminEmail,
      adminPhone: parsed.data.adminPhone ?? null,
      teamGithubUsernames: parsed.data.teamGithubUsernames,
      brandPrimaryColor: parsed.data.brandPrimaryColor,
      brandSecondaryColor: parsed.data.brandSecondaryColor ?? null,
      brandLogoUrl: parsed.data.brandLogoUrl ?? null,
      brandFaviconUrl: parsed.data.brandFaviconUrl ?? null,
      sidebarTheme: parsed.data.sidebarTheme,
      dashboardType: parsed.data.dashboardType,
      integrations: {
        shopify: {
          enabled: parsed.data.integrations.shopify.enabled,
          storeUrl: parsed.data.integrations.shopify.storeUrl ?? null,
          sync: parsed.data.integrations.shopify.sync,
        },
        bigcommerce: {
          enabled: parsed.data.integrations.bigcommerce.enabled,
          storeHash: parsed.data.integrations.bigcommerce.storeHash ?? null,
          sync: parsed.data.integrations.bigcommerce.sync,
        },
      },
      enabledModules: parsed.data.enabledModules,
      planTier: parsed.data.planTier,
      userSeats: parsed.data.userSeats,
      goLiveDate: parsed.data.goLiveDate ?? null,
      notes: parsed.data.notes ?? null,
      provisionedBy: login,
    });
    const handoff: IntegrationHandoff = {};
    if (parsed.data.dashboardType === 'middleware') {
      const s = parsed.data.integrations.shopify;
      if (s.enabled && s.storeUrl && s.accessToken) {
        handoff.shopify = {
          storeUrl: s.storeUrl,
          accessToken: s.accessToken,
          ...(s.webhookSecret ? { webhookSecret: s.webhookSecret } : {}),
        };
      }
      const b = parsed.data.integrations.bigcommerce;
      if (b.enabled && b.storeHash && b.accessToken) {
        handoff.bigcommerce = {
          storeHash: b.storeHash,
          accessToken: b.accessToken,
          ...(b.clientId ? { clientId: b.clientId } : {}),
        };
      }
    }
    return {
      ok: true,
      sessionId: result.sessionId,
      provisioningId: result.provisioningId,
      previewUrl: result.previewUrl,
      adminEmail: result.adminEmail,
      expiresAt: result.expiresAt,
      ...(handoff.shopify || handoff.bigcommerce ? { integrationHandoff: handoff } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[startApplyAndPreview] unexpected error:', message);
    if (
      message.startsWith('[env]') ||
      message.startsWith('[provisioning] preflight failed') ||
      message.startsWith('[modules]') ||
      message.startsWith('[slug]')
    ) {
      return {
        ok: false,
        friendlyError: `${message}. If you just updated the module list, hard-refresh this page (Ctrl+Shift+R).`,
      };
    }
    // ProvisioningError already wrote the friendly text to DB — surface it.
    const friendly = (err as { friendlyMessage?: string }).friendlyMessage ?? message;
    return { ok: false, friendlyError: friendly };
  }
}

// ─── approveProvisioning ──────────────────────────────────────────────────────

/** Phase D. Creates the GitHub repo and pushes. */
export async function approveProvisioning(
  sessionId: string,
): Promise<ApproveActionResult> {
  const session = await auth();
  const login = (session?.user as { login?: string } | undefined)?.login;
  if (!session?.user || !login) {
    return { ok: false, friendlyError: 'Your session has expired. Please sign in again.' };
  }
  if (!/^[a-f0-9]{32}$/i.test(sessionId)) {
    return { ok: false, friendlyError: 'Invalid session identifier.' };
  }

  try {
    const service = new ProvisioningService();
    const result = await service.approve(sessionId, login);
    if (result.status === 'READY') {
      return { ok: true, repoUrl: result.repoUrl, warnings: result.warnings };
    }
    return { ok: false, friendlyError: result.friendlyError, referenceId: result.referenceId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[approveProvisioning] unexpected error:', message);
    const friendly = (err as { friendlyMessage?: string }).friendlyMessage ??
      'Something went wrong while creating the repository. Please try again.';
    return { ok: false, friendlyError: friendly };
  }
}

// ─── cancelProvisioning ───────────────────────────────────────────────────────

/** Phase E. Kills the preview, wipes the tmp dir. No GitHub side effects. */
export async function cancelProvisioning(
  sessionId: string,
): Promise<{ ok: boolean; friendlyError?: string }> {
  const session = await auth();
  const login = (session?.user as { login?: string } | undefined)?.login;
  if (!session?.user || !login) {
    return { ok: false, friendlyError: 'Your session has expired. Please sign in again.' };
  }
  if (!/^[a-f0-9]{32}$/i.test(sessionId)) {
    return { ok: false, friendlyError: 'Invalid session identifier.' };
  }

  try {
    const service = new ProvisioningService();
    await service.cancel(sessionId, login);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[cancelProvisioning] unexpected error:', message);
    return { ok: false, friendlyError: 'Could not cancel the preview. Please try again.' };
  }
}

// ─── startProvisioning (legacy / headless) ────────────────────────────────────

/**
 * Legacy one-step entry point used by scripts/provision.ts via the CLI skill.
 * Delegates to create() which wraps applyAndPreview + approve with no human gate.
 */
export async function startProvisioning(
  input: StartProvisioningInput,
): Promise<StartProvisioningResult> {
  const session = await auth();
  const login = (session?.user as { login?: string } | undefined)?.login;
  if (!session?.user || !login) {
    return { ok: false, friendlyError: 'Your session has expired. Please sign in again.' };
  }

  const normalized: StartProvisioningInput = stripIntegrationsIfNotMiddleware({
    ...input,
    slug: isValidSlug(input.slug) ? input.slug : normalizeSlug(input.slug),
  });

  const parsed = onboardFormSchema.safeParse(normalized);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.');
      if (!fieldErrors[path]) fieldErrors[path] = issue.message;
    }
    return { ok: false, fieldErrors };
  }

  try {
    const service = new ProvisioningService();
    const result = await service.create({
      provisioningId: parsed.data.provisioningId,
      name: parsed.data.name,
      slug: parsed.data.slug,
      industry: parsed.data.industry ?? null,
      country: parsed.data.country ?? null,
      timezone: parsed.data.timezone,
      adminName: parsed.data.adminName,
      adminEmail: parsed.data.adminEmail,
      adminPhone: parsed.data.adminPhone ?? null,
      teamGithubUsernames: parsed.data.teamGithubUsernames,
      brandPrimaryColor: parsed.data.brandPrimaryColor,
      brandSecondaryColor: parsed.data.brandSecondaryColor ?? null,
      brandLogoUrl: parsed.data.brandLogoUrl ?? null,
      brandFaviconUrl: parsed.data.brandFaviconUrl ?? null,
      sidebarTheme: parsed.data.sidebarTheme,
      dashboardType: parsed.data.dashboardType,
      integrations: {
        shopify: {
          enabled: parsed.data.integrations.shopify.enabled,
          storeUrl: parsed.data.integrations.shopify.storeUrl ?? null,
          sync: parsed.data.integrations.shopify.sync,
        },
        bigcommerce: {
          enabled: parsed.data.integrations.bigcommerce.enabled,
          storeHash: parsed.data.integrations.bigcommerce.storeHash ?? null,
          sync: parsed.data.integrations.bigcommerce.sync,
        },
      },
      enabledModules: parsed.data.enabledModules,
      planTier: parsed.data.planTier,
      userSeats: parsed.data.userSeats,
      goLiveDate: parsed.data.goLiveDate ?? null,
      notes: parsed.data.notes ?? null,
      provisionedBy: login,
    });
    return { ok: true, provisioningId: result.provisioningId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[startProvisioning] unexpected error:', message);
    if (
      message.startsWith('[env]') ||
      message.startsWith('[provisioning] preflight failed') ||
      message.startsWith('[modules]') ||
      message.startsWith('[slug]')
    ) {
      return {
        ok: false,
        friendlyError: `${message}. If you just updated the module list, hard-refresh this page (Ctrl+Shift+R).`,
      };
    }
    return {
      ok: false,
      friendlyError: 'We could not start the provisioning. Check the server logs for details.',
    };
  }
}
