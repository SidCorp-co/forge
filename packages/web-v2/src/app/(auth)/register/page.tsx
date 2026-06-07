import Link from 'next/link';
import { AuthShell } from '@/features/auth/components/auth-shell';
import { SocialLogin } from '@/features/auth/components/social-login';
import { RegisterForm } from '@/features/auth/register-form';

export default function RegisterPage() {
  return (
    <AuthShell
      title="Create your account"
      subtitle="One account drives every issue, agent, and chat across your projects."
      footer={
        <>
          Already have an account?{' '}
          <Link href="/login" className="text-link font-semibold">
            Sign in
          </Link>
        </>
      }
    >
      {/* Social sign-up uses the same OAuth flow as sign-in — renders only when
          providers are configured server-side. */}
      <SocialLogin redirectTo="/" />
      <RegisterForm />
    </AuthShell>
  );
}
