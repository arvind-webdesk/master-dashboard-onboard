import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import type { SeedData } from './TemplateCloner';
import type { ProvisionInput } from './ProvisioningService';

/**
 * PreviewSessionManager — in-memory store for live preview sessions.
 *
 * NOTE: On Next.js dev-server restart, in-memory state is lost and all
 * in-flight sessions are gone. Staff must restart the apply flow if the
 * server restarts during a preview window. This is acceptable because sessions
 * are short (≤30 min) and this is an internal tool.
 *
 * Concurrent session cap: 10 (CLAUDE.md resource cap). Port pool is 3001–3099.
 */

export interface PreviewSession {
  sessionId: string;
  provisioningId: string;
  clientId: string;
  shortId: string;
  slug: string;
  tmpDir: string;
  port: number;
  child: ChildProcess | null;
  commitSha: string | null;
  seed: SeedData;
  input: ProvisionInput;
  createdAt: Date;
  lastTouchedAt: Date;
  expiresAt: Date;
  /** Ring buffer: last 100 stderr lines. */
  stderrTail: string[];
  state: 'applying' | 'previewing' | 'approving' | 'done' | 'cancelled' | 'failed';
}

export const IDLE_TIMEOUT_MS = 20 * 60_000; // 20 minutes
export const HARD_TTL_MS = 30 * 60_000; // 30 minutes
const MAX_CONCURRENT = 10;

// ─── Port Pool ────────────────────────────────────────────────────────────────

export class PortPool {
  private available: Set<number>;

  constructor(min: number, max: number) {
    this.available = new Set<number>();
    for (let p = min; p <= max; p++) this.available.add(p);
  }

  acquire(): number {
    const port = this.available.values().next().value;
    if (port === undefined) throw new Error('[port-pool] all preview ports are in use');
    this.available.delete(port);
    return port;
  }

  release(port: number): void {
    this.available.add(port);
  }

  get size(): number {
    return this.available.size;
  }
}

// ─── Session Manager ──────────────────────────────────────────────────────────

export class PreviewSessionManager {
  private sessions = new Map<string, PreviewSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pool: PortPool;

  constructor(pool: PortPool) {
    this.pool = pool;
  }

  /** Start the background cleanup worker. Call once at first use. */
  startCleanupWorker(
    onCleanup: (session: PreviewSession) => Promise<void>,
  ): void {
    if (this.cleanupTimer) return; // already running
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, s] of this.sessions) {
        const idleExpired = now - s.lastTouchedAt.getTime() > IDLE_TIMEOUT_MS;
        const hardExpired = now - s.createdAt.getTime() > HARD_TTL_MS;
        if (idleExpired || hardExpired) {
          // Fire-and-forget — errors are logged inside onCleanup.
          onCleanup(s).catch((err: unknown) => {
            console.error('[preview-cleanup] error cleaning up session', id, (err as Error).message);
          });
          this.sessions.delete(id);
        }
      }
    }, 60_000);
  }

  create(params: {
    provisioningId: string;
    clientId: string;
    shortId: string;
    slug: string;
    tmpDir: string;
    port: number;
    seed: SeedData;
    input: ProvisionInput;
  }): PreviewSession {
    if (this.sessions.size >= MAX_CONCURRENT) {
      throw new Error(
        `[preview] maximum concurrent preview sessions (${MAX_CONCURRENT}) reached. ` +
          'Cancel an existing session before starting a new one.',
      );
    }
    const sessionId = randomBytes(16).toString('hex');
    const now = new Date();
    const session: PreviewSession = {
      sessionId,
      provisioningId: params.provisioningId,
      clientId: params.clientId,
      shortId: params.shortId,
      slug: params.slug,
      tmpDir: params.tmpDir,
      port: params.port,
      child: null,
      commitSha: null,
      seed: params.seed,
      input: params.input,
      createdAt: now,
      lastTouchedAt: now,
      expiresAt: new Date(now.getTime() + HARD_TTL_MS),
      stderrTail: [],
      state: 'applying',
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): PreviewSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  touch(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.lastTouchedAt = new Date();
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Find the active non-done session for a given staff user (by provisioningId prefix). */
  findByClientId(clientId: string): PreviewSession | null {
    for (const s of this.sessions.values()) {
      if (s.clientId === clientId && s.state !== 'done' && s.state !== 'cancelled') {
        return s;
      }
    }
    return null;
  }

  all(): PreviewSession[] {
    return Array.from(this.sessions.values());
  }
}

// ─── Singletons ───────────────────────────────────────────────────────────────
// Lazy-initialised so they are not constructed at module load time.

let _pool: PortPool | null = null;
let _manager: PreviewSessionManager | null = null;

export function getPortPool(): PortPool {
  if (!_pool) _pool = new PortPool(3001, 3099);
  return _pool;
}

export function getPreviewSessionManager(): PreviewSessionManager {
  if (!_manager) _manager = new PreviewSessionManager(getPortPool());
  return _manager;
}
