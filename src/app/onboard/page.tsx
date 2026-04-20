import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth, signOut } from '@/lib/auth';
import { defaultModuleSource } from '@/lib/modules';
import { OnboardForm } from './_components/OnboardForm';

export default async function OnboardPage() {
  const session = await auth();
  if (!session?.user) redirect('/signin');

  const login = (session.user as { login?: string }).login ?? 'staff';
  const modules = await defaultModuleSource.list();

  return (
    <div className="mx-auto max-w-2xl p-6 md:p-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Onboard a new client</h1>
          <p className="mt-1 text-sm text-gray-600">
            Fill in the basics and we&apos;ll create a private GitHub repository for this client.
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <Link
            href="/clients"
            className="rounded-md border border-surface-border bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-surface-muted"
          >
            View provisioned clients →
          </Link>
          <form
            action={async () => {
              'use server';
              await signOut({ redirectTo: '/signin' });
            }}
          >
            <button
              type="submit"
              className="rounded-md border border-surface-border bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-surface-muted"
            >
              Sign out ({login})
            </button>
          </form>
        </div>
      </header>

      <div className="mt-8">
        <OnboardForm modules={modules} />
      </div>
    </div>
  );
}
