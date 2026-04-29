import Link from 'next/link';
import { AuthCard } from '../components/auth-card';
import { SocialLogin } from '../components/social-login';
import { LoginForm } from './login-form';

interface LoginPageProps {
  searchParams: Promise<{
    registered?: string;
    email?: string;
    oauth_error?: string;
    verified?: string;
    verify_error?: string;
  }>;
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

// Codes set by core's GET /api/auth/verify redirect. Mirror of OAuth banner
// pattern so the user lands on /login with a friendly message instead of raw
// JSON or a 400 page.
const VERIFY_ERROR_MESSAGES: Record<string, string> = {
  invalid: 'This verification link is invalid or has already been used.',
  expired: 'Verification link expired (valid for 24 hours). Sign in to request a new one.',
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const sp = await searchParams;
  const justRegistered = sp.registered === '1';
  const justVerified = sp.verified === '1';
  const presetEmail = typeof sp.email === 'string' ? sp.email : '';
  const oauthErrorCode = typeof sp.oauth_error === 'string' ? sp.oauth_error : null;
  const oauthErrorMessage = oauthErrorCode
    ? OAUTH_ERROR_MESSAGES[oauthErrorCode] ?? OAUTH_ERROR_MESSAGES.provider_error
    : null;
  const verifyErrorCode = typeof sp.verify_error === 'string' ? sp.verify_error : null;
  const verifyErrorMessage = verifyErrorCode
    ? VERIFY_ERROR_MESSAGES[verifyErrorCode] ?? VERIFY_ERROR_MESSAGES.invalid
    : null;

  return (
    <AuthCard
      eyebrow="Authenticate"
      title="Sign in to Forge"
      description="Pick up the pipeline where you left it."
    >
      {justVerified && (
        <div
          role="status"
          className="mb-6 border-l-2 border-l-success bg-success/10 px-4 py-3 font-mono text-[11px] uppercase tracking-[0.16em] text-on-surface"
        >
          Email verified. You can sign in now.
        </div>
      )}

      {justRegistered && (
        <div
          role="status"
          className="mb-6 border-l-2 border-l-warning bg-warning/10 px-4 py-3 font-mono text-[11px] uppercase tracking-[0.16em] text-on-surface"
        >
          Account created. Verification email sent — you can sign in now.
        </div>
      )}

      {verifyErrorMessage && (
        <div
          role="alert"
          className="mb-6 border-l-2 border-l-warning bg-warning/10 px-4 py-3 font-mono text-[11px] uppercase tracking-[0.16em] text-on-surface"
        >
          {verifyErrorMessage}
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
