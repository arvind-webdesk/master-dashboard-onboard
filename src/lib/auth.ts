import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';
import { getStaffAuthEnv } from './env';

/**
 * NextAuth v5 configuration.
 *
 * Any authenticated GitHub user is allowed in. There is NO organization
 * membership check — the onboarding tool trusts whoever completes the GitHub
 * OAuth flow. Intended usage is a local / single-operator deployment.
 *
 * If you later need to restrict access, either (a) reintroduce an
 * org-membership check here, or (b) gate sign-in behind a static allowlist of
 * GitHub logins.
 */

interface JwtExtras {
  login?: string;
}

const env = (() => {
  try {
    return getStaffAuthEnv();
  } catch {
    // Allow the module to load even when env is incomplete (e.g. during build).
    // Sign-in will fail with a clear error at runtime.
    return null;
  }
})();

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Explicitly pass secret so NextAuth v5 doesn't fall back to AUTH_SECRET alone.
  secret: env?.NEXTAUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET,
  trustHost: true,
  providers: [
    GitHub({
      clientId: env?.GITHUB_CLIENT_ID ?? '',
      clientSecret: env?.GITHUB_CLIENT_SECRET ?? '',
      authorization: { params: { scope: 'read:user' } },
    }),
  ],
  session: { strategy: 'jwt' },
  callbacks: {
    async signIn({ profile }) {
      // Any authenticated GitHub user is allowed in.
      return Boolean(profile?.login);
    },
    async jwt({ token, profile }) {
      const t = token as typeof token & JwtExtras;
      if (profile?.login) t.login = String(profile.login);
      return t;
    },
    async session({ session, token }) {
      const t = token as typeof token & JwtExtras;
      if (session.user) {
        (session.user as typeof session.user & { login?: string }).login = t.login;
      }
      return session;
    },
  },
  pages: {
    signIn: '/signin',
    error: '/signin',
  },
});
