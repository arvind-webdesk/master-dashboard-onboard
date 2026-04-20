import { z } from 'zod';

/**
 * Runtime environment validation for the onboarding tool.
 *
 * Split into two groups:
 *   - staffAuthEnv:   required for NextAuth sign-in (staff can't even log in without these)
 *   - provisioningEnv: required for ProvisioningService.create() (validated at call time)
 *
 * Split so that the app can still show a useful sign-in page during dev even
 * if the provisioning vars are missing.
 *
 * NOTE: never log the parsed values. Only `has<X>` booleans and missing-key
 * names are safe to surface.
 */

const staffAuthSchema = z.object({
  DATABASE_URL: z.string().min(1),
  NEXTAUTH_SECRET: z.string().min(16),
  NEXTAUTH_URL: z.string().url(),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
});

const provisioningSchema = z.object({
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_ORG: z.string().min(1),
  TEMPLATE_REPO_URL: z.string().min(1),
});

export type StaffAuthEnv = z.infer<typeof staffAuthSchema>;
export type ProvisioningEnv = z.infer<typeof provisioningSchema>;

let _staffAuthEnv: StaffAuthEnv | null = null;
let _provisioningEnv: ProvisioningEnv | null = null;

export function getStaffAuthEnv(): StaffAuthEnv {
  if (_staffAuthEnv) return _staffAuthEnv;
  const parsed = staffAuthSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(
      `[env] Missing or invalid staff-auth environment variables: ${missing}. ` +
        'See .env.example.',
    );
  }
  _staffAuthEnv = parsed.data;
  return _staffAuthEnv;
}

export function getProvisioningEnv(): ProvisioningEnv {
  if (_provisioningEnv) return _provisioningEnv;
  const parsed = provisioningSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(
      `[env] Missing or invalid provisioning environment variables: ${missing}. ` +
        'See .env.example.',
    );
  }
  _provisioningEnv = parsed.data;
  return _provisioningEnv;
}

/**
 * Non-throwing status check for the UI / preflight banner.
 * Returns which required vars are set (booleans only, never values).
 */
export function getEnvStatus(): { staffAuth: boolean; provisioning: boolean } {
  return {
    staffAuth: staffAuthSchema.safeParse(process.env).success,
    provisioning: provisioningSchema.safeParse(process.env).success,
  };
}
