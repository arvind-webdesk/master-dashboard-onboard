import { PrismaClient } from '@prisma/client';

/**
 * PrismaClient singleton.
 *
 * Next.js hot-reloads modules in dev, so we attach the client to the global
 * object to avoid exhausting connections.
 */

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__prisma = prisma;
}
