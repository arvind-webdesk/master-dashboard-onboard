import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { ProvisioningService } from '@/services/ProvisioningService';
import { normalizeSlug, isValidSlug } from '@/lib/slug';

/**
 * POST /api/provision/apply
 *
 * Phase A–C: validate → clone → apply:config → typecheck → start preview.
 * Returns the preview session payload. NO GitHub side effects.
 *
 * Request body: same shape as ProvisionInput (JSON).
 * Response:
 *   200: { sessionId, provisioningId, previewUrl, adminEmail, expiresAt }
 *   400: { fieldErrors }
 *   401: { error }
 *   500: { friendlyError }
 */

export const dynamic = 'force-dynamic';

const emptyToUndef = (v: unknown) => (v === '' ? undefined : v);
const optionalString = z.preprocess(emptyToUndef, z.string().optional());
const optionalUrl = z.preprocess(
  emptyToUndef,
  z.string().url('Please enter a full URL (including https://).').optional(),
);
const optionalHexColor = z.preprocess(
  emptyToUndef,
  z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Pick a valid hex color.').optional(),
);

const applySchema = z.object({
  provisioningId: z.string().optional(),
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(3)
    .max(40)
    .regex(/^[a-z0-9-]+$/),
  industry: optionalString,
  country: optionalString,
  timezone: z.string().min(1),
  adminName: z.string().min(1).max(120),
  adminEmail: z.string().email(),
  adminPhone: optionalString,
  teamGithubUsernames: z.preprocess(
    (v) => {
      if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
      if (typeof v === 'string')
        return v
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
      return [];
    },
    z
      .array(
        z.string().regex(/^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/),
      )
      .max(20),
  ),
  brandPrimaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  brandSecondaryColor: optionalHexColor,
  brandLogoUrl: optionalUrl,
  brandFaviconUrl: optionalUrl,
  dashboardType: z.enum(['custom', 'middleware', 'saas']).default('custom'),
  integrations: z
    .object({
      shopify: z.object({
        enabled: z.boolean(),
        storeUrl: z.preprocess(emptyToUndef, z.string().optional()),
        sync: z.object({
          products: z.boolean(),
          orders: z.boolean(),
          customers: z.boolean(),
        }),
      }),
      bigcommerce: z.object({
        enabled: z.boolean(),
        storeHash: z.preprocess(emptyToUndef, z.string().optional()),
        sync: z.object({
          products: z.boolean(),
          orders: z.boolean(),
          customers: z.boolean(),
        }),
      }),
    })
    .default({
      shopify: {
        enabled: false,
        sync: { products: false, orders: false, customers: false },
      },
      bigcommerce: {
        enabled: false,
        sync: { products: false, orders: false, customers: false },
      },
    }),
  enabledModules: z.array(z.string().min(1)).min(1),
  planTier: z.enum(['starter', 'pro', 'enterprise']),
  userSeats: z.number().int().min(1).max(10000),
  goLiveDate: optionalString,
  notes: z.preprocess(emptyToUndef, z.string().max(1000).optional()),
});

export async function POST(req: Request): Promise<Response> {
  const session = await auth();
  const login = (session?.user as { login?: string } | undefined)?.login;
  if (!session?.user || !login) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  // Normalize slug server-side before validation.
  if (body && typeof body === 'object' && 'slug' in body) {
    const raw = (body as Record<string, unknown>).slug;
    if (typeof raw === 'string' && !isValidSlug(raw)) {
      (body as Record<string, unknown>).slug = normalizeSlug(raw);
    }
  }

  // Strip stale integrations payload when the dashboard isn't middleware, so
  // leftover enabled flags / invalid URLs from an abandoned step don't fail validation.
  if (body && typeof body === 'object' && (body as Record<string, unknown>).dashboardType !== 'middleware') {
    const emptySync = { products: false, orders: false, customers: false };
    (body as Record<string, unknown>).integrations = {
      shopify: { enabled: false, sync: emptySync },
      bigcommerce: { enabled: false, sync: emptySync },
    };
  }

  const parsed = applySchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.');
      if (!fieldErrors[path]) fieldErrors[path] = issue.message;
    }
    return NextResponse.json({ fieldErrors }, { status: 400 });
  }

  try {
    const service = new ProvisioningService();
    const result = await service.applyAndPreview({
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
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const friendly =
      (err as { friendlyMessage?: string }).friendlyMessage ??
      'Something went wrong while preparing the preview. Please try again or contact support.';
    // Never leak technical detail to the browser.
    console.error('[POST /api/provision/apply] error:', err instanceof Error ? err.message : err);
    return NextResponse.json({ friendlyError: friendly }, { status: 500 });
  }
}
