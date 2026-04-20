import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { ProvisioningService } from '@/services/ProvisioningService';

/**
 * POST /api/provision/:id/approve
 *
 * Phase D: kill preview, create GitHub repo, push, finalize.
 * Returns { status, repoUrl?, warnings? } on success.
 *
 * 404 if the session is not found or has already been closed.
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
    const result = await service.approve(id, login);
    if (result.status === 'READY') {
      return NextResponse.json(
        { status: 'READY', repoUrl: result.repoUrl, warnings: result.warnings ?? [] },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return NextResponse.json(
      { status: 'FAILED', friendlyError: result.friendlyError, referenceId: result.referenceId },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    const friendly =
      (err as { friendlyMessage?: string }).friendlyMessage ??
      'The preview session was not found or has already expired. Please start a new Apply & preview.';
    // ProvisioningError for missing session → 404; others → 500.
    const isNotFound = (err as Error).message?.includes('not found or has already been closed');
    return NextResponse.json(
      { friendlyError: friendly },
      { status: isNotFound ? 404 : 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
