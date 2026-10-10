import Link from 'next/link';
import { AuthShell } from '@/features/auth/components/auth-shell';
import { SocialLogin } from '@/features/auth/components/social-login';
import { RegisterForm } from '@/features/auth/register-form';
import { productCopy } from '@/lib/i18n/product-copy';

// a server page reads copy without a hook; the copy is English only
const t = productCopy();

export default function RegisterPage() {
  return (
    <AuthShell
      title={t('auth.register.title')}
      footer={
        <>
          {t('auth.register.haveAccount')}{' '}
          <Link href="/login" className="text-link font-semibold">
            {t('auth.register.signIn')}
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
