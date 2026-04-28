import Link from 'next/link';
import { AuthCard } from '../components/auth-card';
import { SocialLogin } from '../components/social-login';
import { LoginForm } from './login-form';

interface LoginPageProps {
  searchParams: Promise<{ registered?: string; email?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const sp = await searchParams;
  const justRegistered = sp.registered === '1';
  const presetEmail = typeof sp.email === 'string' ? sp.email : '';

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
