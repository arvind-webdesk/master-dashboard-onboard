import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getProvisioningStatus, getPreviewSessionStatus } from '@/services/ProvisioningService';

/**
 * GET /api/provision/:id/status
 *
 * Dual-mode lookup:
 *   - If :id matches a live preview sessionId (32-char hex) → return session state
 *     (used by the UI during the 'applying' and 'approving' states).
 *   - Else fall back to provisioningId → Client DB row (legacy path, unchanged).
 *
 * The UI polls this every 2s while in applying / approving states.
 */

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { id } = await context.params;
  if (!/^[a-f0-9]{32}$/i.test(id)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }

  // Try preview session first (in-memory, fast).
  const sessionStatus = getPreviewSessionStatus(id);
  if (sessionStatus) {
    return NextResponse.json(
      {
        kind: 'preview-session',
        state: sessionStatus.state,
        previewUrl: sessionStatus.previewUrl,
        expiresAt: sessionStatus.expiresAt,
        slug: sessionStatus.slug,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // Fall back to provisioningId DB lookup.
  const status = await getProvisioningStatus(id);
  if (!status) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  return NextResponse.json(
    {
      kind: 'provisioning',
      status: status.status,
      slug: status.slug,
      repoUrl: status.repoUrl,
      friendlyError: status.friendlyError,
      referenceId: status.referenceId,
      warnings: status.warnings,
      previewSessionId: status.previewSessionId,
      steps: status.steps,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
