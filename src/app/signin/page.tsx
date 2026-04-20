import { signIn } from '@/lib/auth';
import { getEnvStatus } from '@/lib/env';

interface Props {
  searchParams: Promise<{ error?: string }>;
}

const ERROR_MESSAGES: Record<string, string> = {
  AccessDenied: 'Sign-in was denied by GitHub.',
  Configuration:
    'Sign-in is not configured. Set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, and NEXTAUTH_SECRET in .env.local and restart the dev server.',
  Default: 'Something went wrong while signing in.',
};

export default async function SignInPage({ searchParams }: Props) {
  const { error } = await searchParams;
  const envOk = getEnvStatus().staffAuth;
  const message = error ? ERROR_MESSAGES[error] ?? ERROR_MESSAGES.Default : null;

  return (
    <div className="mx-auto flex min-h-screen max-w-md items-center justify-center p-6">
      <div className="w-full rounded-xl border border-surface-border bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <p className="mt-2 text-sm text-gray-600">
          This is an internal tool. Sign in with your GitHub account.
        </p>

        {message ? (
          <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            {message}
          </div>
        ) : null}

        {!envOk ? (
          <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <strong className="block">Sign-in is not configured yet.</strong>
            <p className="mt-1">
              Copy <code className="font-mono">.env.example</code> to{' '}
              <code className="font-mono">.env.local</code> and set:
            </p>
            <ul className="mt-2 list-inside list-disc space-y-0.5 font-mono text-xs">
              <li>NEXTAUTH_SECRET</li>
              <li>NEXTAUTH_URL (http://localhost:3000)</li>
              <li>GITHUB_CLIENT_ID</li>
              <li>GITHUB_CLIENT_SECRET</li>
              <li>DATABASE_URL</li>
            </ul>
            <p className="mt-2">Then restart the dev server.</p>
          </div>
        ) : (
          <form
            action={async () => {
              'use server';
              await signIn('github', { redirectTo: '/onboard' });
            }}
            className="mt-6"
          >
            <button
              type="submit"
              className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-800"
            >
              Continue with GitHub
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
