import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { ProvisioningService } from '@/services/ProvisioningService';

/**
 * POST /api/provision/:id/cancel
 *
 * Phase E: kill preview, wipe tmpDir, mark DB row cancelled.
 * No GitHub side effects.
 *
 * Returns 204 No Content on success.
 */

export const dynamic = 'force-dynamic';

export async function POST(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await auth();
  const login = (session?.user as { login?: string } | undefined)?.login;
  if (!session?.user || !login) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { id } = await context.params;
  if (!/^[a-f0-9]{32}$/i.test(id)) {
    return NextResponse.json({ error: 'invalid session id' }, { status: 400 });
  }

  try {
    const service = new ProvisioningService();
    await service.cancel(id, login);
    return new Response(null, { status: 204 });
  } catch (err) {
    console.error('[POST cancel] error:', (err as Error).message);
    return NextResponse.json(
      { friendlyError: 'Could not cancel the preview. Please try again.' },
      { status: 500 },
    );
  }
}
