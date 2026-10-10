import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Banner } from '@/design';
import { AuthShell } from '@/features/auth/components/auth-shell';
import { SocialLogin } from '@/features/auth/components/social-login';
import { LoginForm } from '@/features/auth/login-form';
import { type Copy, productCopy } from '@/lib/i18n/product-copy';

interface LoginPageProps {
  searchParams: Promise<{
    registered?: string;
    email?: string;
    oauth_error?: string;
    session?: string;
  }>;
}

// Stable codes set by core's OAuth callback redirect. Anything else falls back
// to a generic message so a stray query param can't break the banner.
const OAUTH_ERROR_MESSAGES: Record<string, (t: Copy) => string> = {
  denied: (t) => t('auth.oauthRefused.denied'),
  session_expired: (t) => t('auth.oauthRefused.sessionExpired'),
  email_unverified: (t) => t('auth.oauthRefused.emailUnverified'),
  provider_error: (t) => t('auth.oauthRefused.providerError'),
};

// a server page reads copy without a hook; the copy is English only
const t = productCopy();

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const sp = await searchParams;
  // Forge previewing itself on demo data (`pnpm preview:demo`) signs its member in on the web server
  // (lib/demo-signin.ts): the browser holds no session and needs none, so a person who lands here is
  // sent home, to a page the server already answers as the demo member. A sign-out lands here with
  // session=ended and is shown the form. Never a redirect to an API route: the client router fetches
  // that as a page and ends blank.
  if (process.env.FORGE_DEMO_SIGNIN === '1' && sp.session !== 'ended') redirect('/');
  const justRegistered = sp.registered === '1';
  const presetEmail = typeof sp.email === 'string' ? sp.email : '';
  const oauthErrorCode = typeof sp.oauth_error === 'string' ? sp.oauth_error : null;
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
      <LoginForm presetEmail={presetEmail} sessionEnded={sp.session === 'ended'} />
    </AuthShell>
  );
}
