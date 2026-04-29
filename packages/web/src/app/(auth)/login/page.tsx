import Link from 'next/link';
import { AuthCard } from '../components/auth-card';
import { SocialLogin } from '../components/social-login';
import { LoginForm } from './login-form';

interface LoginPageProps {
  searchParams: Promise<{ registered?: string; email?: string; oauth_error?: string }>;
}

// Stable codes set by core's OAuth callback redirect. Anything else falls
// back to a generic message so a stray query param can't break the banner.
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
  const oauthErrorMessage = oauthErrorCode
    ? OAUTH_ERROR_MESSAGES[oauthErrorCode] ?? OAUTH_ERROR_MESSAGES.provider_error
    : null;

  return (
    <AuthCard
      eyebrow="Authenticate"
      title="Sign in to Forge"
      description="Pick up the pipeline where you left it."
    >
      {justRegistered && (
        <div
          role="status"
          className="mb-6 border-l-2 border-l-warning bg-warning/10 px-4 py-3 font-mono text-[11px] uppercase tracking-[0.16em] text-on-surface"
        >
          Account created. Verification email sent — you can sign in now.
        </div>
      )}

      {oauthErrorMessage && (
        <div
          role="alert"
          className="mb-6 border-l-2 border-l-warning bg-warning/10 px-4 py-3 font-mono text-[11px] uppercase tracking-[0.16em] text-on-surface"
        >
          {oauthErrorMessage}
        </div>
      )}

      {/* Server-side fetch of /api/auth/oauth/providers — renders nothing
          when FEATURE_SOCIAL_AUTH is off or no providers are configured. */}
      <SocialLogin redirectTo="/projects" />

      <LoginForm presetEmail={presetEmail} />

      <p className="mt-8 font-mono text-[11px] uppercase tracking-[0.18em] text-on-surface-variant">
        New here?{' '}
        <Link
          href="/register"
          className="text-on-surface underline decoration-warning decoration-2 underline-offset-4 hover:text-warning transition-colors"
        >
          Create account ↗
        </Link>
      </p>
    </AuthCard>
  );
}
