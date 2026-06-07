import Link from 'next/link';
import { Banner } from '@/design';
import { AuthShell } from '@/features/auth/components/auth-shell';
import { SocialLogin } from '@/features/auth/components/social-login';
import { LoginForm } from '@/features/auth/login-form';

interface LoginPageProps {
  searchParams: Promise<{
    registered?: string;
    email?: string;
    oauth_error?: string;
  }>;
}

// Stable codes set by core's OAuth callback redirect. Anything else falls back
// to a generic message so a stray query param can't break the banner.
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  denied: 'Sign-in cancelled. Try again or use email + password below.',
  session_expired: 'OAuth session timed out. Please retry — the link is good for 10 minutes.',
  email_unverified:
    'Your provider did not return a verified email. Verify it on the provider side, then retry.',
  provider_error: 'Could not complete sign-in. Try again or use email + password below.',
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const sp = await searchParams;
  const justRegistered = sp.registered === '1';
  const presetEmail = typeof sp.email === 'string' ? sp.email : '';
  const oauthErrorCode = typeof sp.oauth_error === 'string' ? sp.oauth_error : null;
  const oauthError = oauthErrorCode
    ? OAUTH_ERROR_MESSAGES[oauthErrorCode] ?? OAUTH_ERROR_MESSAGES.provider_error
    : null;

  return (
    <AuthShell
      title="Sign in"
      subtitle="Welcome back. Pick up where the pipeline left off."
      footer={
        <>
          New to Forge?{' '}
          <Link href="/register" className="text-link font-semibold">
            Create an account
          </Link>
        </>
      }
    >
      {justRegistered && (
        <div className="mb-4">
          <Banner tone="success">Account created. You can sign in now.</Banner>
        </div>
      )}
      {oauthError && (
        <div className="mb-4">
          <Banner tone="danger">{oauthError}</Banner>
        </div>
      )}

      <SocialLogin redirectTo="/" />
      <LoginForm presetEmail={presetEmail} />
    </AuthShell>
  );
}
