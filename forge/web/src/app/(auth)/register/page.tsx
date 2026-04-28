import Link from 'next/link';
import { AuthCard } from '../components/auth-card';
import { SocialLogin } from '../components/social-login';
import { RegisterForm } from './register-form';

export default function RegisterPage() {
  return (
    <AuthCard
      eyebrow="Create account"
      title="Start a new project"
      description="One account drives every issue, agent, and chat across your projects."
    >
      {/* Social sign-up uses the same OAuth flow as sign-in — providers
          render only when configured server-side via env + flag. */}
      <SocialLogin redirectTo="/projects" />

      <RegisterForm />

      <p className="mt-8 font-mono text-[11px] uppercase tracking-[0.18em] text-on-surface-variant">
        Have an account?{' '}
        <Link
          href="/login"
          className="text-on-surface underline decoration-warning decoration-2 underline-offset-4 hover:text-warning transition-colors"
        >
          Sign in ↗
        </Link>
      </p>
    </AuthCard>
  );
}
