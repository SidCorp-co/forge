import Link from 'next/link';
import { Banner } from '@/design';
import { AGENT_ADDRESS_MESSAGE } from '@/features/auth/agent-address';
import { AuthShell } from '@/features/auth/components/auth-shell';
import { SocialLogin } from '@/features/auth/components/social-login';
import { LoginForm } from '@/features/auth/login-form';
import { RETURN_PARAM, readReturnPath } from '@/features/auth/return-path';

interface LoginPageProps {
  searchParams: Promise<{
    registered?: string;
    email?: string;
    oauth_error?: string;
    [RETURN_PARAM]?: string | string[];
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
  agent_address: AGENT_ADDRESS_MESSAGE,
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const sp = await searchParams;
  const justRegistered = sp.registered === '1';
  const presetEmail = typeof sp.email === 'string' ? sp.email : '';
  const oauthErrorCode = typeof sp.oauth_error === 'string' ? sp.oauth_error : null;
  const ret = readReturnPath(sp[RETURN_PARAM]);
  const returnTo = ret.kind === 'path' ? ret.path : undefined;
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

      {ret.kind === 'refused' && (
        <div className="mb-4">
          <Banner tone="attention">
            The return address was ignored: {ret.why}. You will land on the dashboard after signing in.
          </Banner>
        </div>
      )}

      <SocialLogin redirectTo={returnTo} />
      <LoginForm presetEmail={presetEmail} returnTo={returnTo} />
    </AuthShell>
  );
}
