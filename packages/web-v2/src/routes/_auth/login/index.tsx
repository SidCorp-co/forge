import { createFileRoute } from "@tanstack/react-router";
import { Banner } from '@/design';
import { AuthShell } from '@/features/auth/components/auth-shell';
import { SocialLogin } from '@/features/auth/components/social-login';
import { LoginForm } from '@/features/auth/login-form';
import { type Copy, productCopy } from '@/lib/i18n/product-copy';
import { Link, useSearchParams } from "@/lib/navigation/router";

// Stable codes set by core's OAuth callback redirect. Anything else falls back
// to a generic message so a stray query param can't break the banner.
const OAUTH_ERROR_MESSAGES: Record<string, (t: Copy) => string> = {
  denied: (t) => t('auth.oauthRefused.denied'),
  session_expired: (t) => t('auth.oauthRefused.sessionExpired'),
  email_unverified: (t) => t('auth.oauthRefused.emailUnverified'),
  provider_error: (t) => t('auth.oauthRefused.providerError'),
};

// the sign-in page reads copy without a hook; the copy is English only
const t = productCopy();

// A demo core (`pnpm preview:demo`) answers the API as its seeded member and sends this page home
// itself unless a sign-out asked for it (core web-host/spa.ts), so the page has no demo branch.
function LoginPage() {
  const params = useSearchParams();
  const justRegistered = params.get('registered') === '1';
  const presetEmail = params.get('email') ?? '';
  const oauthErrorCode = params.get('oauth_error');
  const oauthError = oauthErrorCode
    ? (OAUTH_ERROR_MESSAGES[oauthErrorCode] ?? OAUTH_ERROR_MESSAGES.provider_error)?.(t)
    : null;

  return (
    <AuthShell
      title={t('auth.login.title')}
      footer={
        <>
          {t('auth.login.newHere')}{' '}
          <Link href="/register" className="text-link font-semibold">
            {t('auth.login.createAccount')}
          </Link>
        </>
      }
    >
      {justRegistered && (
        <div className="mb-4">
          <Banner tone="success">{t('auth.login.registered')}</Banner>
        </div>
      )}
      {oauthError && (
        <div className="mb-4">
          <Banner tone="danger">{oauthError}</Banner>
        </div>
      )}

      <SocialLogin redirectTo="/" />
      <LoginForm presetEmail={presetEmail} sessionEnded={params.get('session') === 'ended'} />
    </AuthShell>
  );
}

export const Route = createFileRoute("/_auth/login/")({ component: LoginPage });
