'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { z } from 'zod';
import { useAuth } from '@/providers/auth-provider';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { extractFieldErrors } from '@/lib/api/extract-field-errors';
import { AuthCard } from '../components/auth-card';
import { Field } from '../components/field';
import { PrimaryButton } from '../components/primary-button';

const loginSchema = z.object({
  email: z.string().trim().min(1, 'Email is required').email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});

type FieldKey = 'email' | 'password';
type FieldErrors = Partial<Record<FieldKey, string>>;
const FIELD_KEYS: readonly FieldKey[] = ['email', 'password'];

function LoginForm() {
  useSetPageTitle('Sign in');
  const { login } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const justRegistered = params.get('registered') === '1';
  const presetEmail = params.get('email') ?? '';

  const [email, setEmail] = useState(presetEmail);
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [topError, setTopError] = useState('');
  const [loading, setLoading] = useState(false);

  // If the user lands here from /register the email arrives via query string;
  // sync once on mount so the field reflects it without re-keying state on
  // every render (which would clobber edits).
  useEffect(() => {
    if (presetEmail && !email) setEmail(presetEmail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTopError('');
    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as FieldKey | undefined;
        if (key && !next[key]) next[key] = issue.message;
      }
      setFieldErrors(next);
      return;
    }
    setFieldErrors({});
    setLoading(true);
    try {
      await login({ email: parsed.data.email, password: parsed.data.password });
      router.push('/projects');
    } catch (err) {
      const fieldMap = extractFieldErrors(err, FIELD_KEYS);
      if (Object.keys(fieldMap).length > 0) {
        setFieldErrors(fieldMap);
      } else {
        setTopError(err instanceof Error ? err.message : 'Sign in failed');
      }
    } finally {
      setLoading(false);
    }
  }

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

      <form onSubmit={handleSubmit} className="space-y-7" noValidate>
        {topError && (
          <div className="border border-error/40 bg-error-container/30 px-4 py-3">
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-on-error-container">
              {topError}
            </p>
          </div>
        )}

        <Field
          id="email"
          name="email"
          type="email"
          label="Email"
          autoComplete="email"
          inputMode="email"
          spellCheck={false}
          autoFocus={!presetEmail}
          placeholder="you@studio.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (fieldErrors.email) setFieldErrors((p) => ({ ...p, email: undefined }));
          }}
          error={fieldErrors.email}
        />

        <Field
          id="password"
          name="password"
          type="password"
          label="Password"
          autoComplete="current-password"
          placeholder="••••••••"
          autoFocus={!!presetEmail}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (fieldErrors.password) setFieldErrors((p) => ({ ...p, password: undefined }));
          }}
          error={fieldErrors.password}
        />

        <PrimaryButton loading={loading} loadingLabel="Signing in…">
          Sign in
        </PrimaryButton>
      </form>

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

export default function LoginPage() {
  // useSearchParams() requires a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
