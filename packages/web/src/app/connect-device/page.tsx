import { ConnectDeviceForm } from './connect-device-form';

// SSR-only — we render based on the `?code=` query param and the auth cookie
// is checked by `middleware.ts` before the page renders. Middleware redirects
// unauthenticated requests to /login.
export const dynamic = 'force-dynamic';

interface ConnectDevicePageProps {
  searchParams: Promise<{ code?: string }>;
}

export default async function ConnectDevicePage({ searchParams }: ConnectDevicePageProps) {
  const sp = await searchParams;
  const initialCode = typeof sp.code === 'string' ? sp.code : '';

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <ConnectDeviceForm initialCode={initialCode} />
    </main>
  );
}
