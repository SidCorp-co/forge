'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { z } from 'zod';
import { useAuth } from '@/providers/auth-provider';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { extractFieldErrors } from '@/lib/api/extract-field-errors';
import { AuthCard } from '../components/auth-card';
import { Field } from '../components/field';
import { PrimaryButton } from '../components/primary-button';

const registerSchema = z
  .object({
    email: z.string().trim().min(1, 'Email is required').email('Enter a valid email'),
    password: z.string().min(8, 'At least 8 characters'),
    confirmPassword: z.string().min(1, 'Confirm your password'),
  })
  .refine((d) => d.password === d.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });

type FieldKey = 'email' | 'password' | 'confirmPassword';
type FieldErrors = Partial<Record<FieldKey, string>>;
const SERVER_FIELD_KEYS = ['email', 'password'] as const;

export default function RegisterPage() {
  useSetPageTitle('Create account');
  const { register } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [topError, setTopError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTopError('');
    const parsed = registerSchema.safeParse({ email, password, confirmPassword });
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
      await register({ email: parsed.data.email, password: parsed.data.password });
      // Hand the email forward so /login can prefill + show the success
      // banner. `replace` keeps the back button useful (lands on whatever the
      // user came from rather than re-opening the register form).
      const next = `/login?registered=1&email=${encodeURIComponent(parsed.data.email)}`;
      router.replace(next);
    } catch (err) {
      const fieldMap = extractFieldErrors(err, SERVER_FIELD_KEYS);
      if (Object.keys(fieldMap).length > 0) {
        setFieldErrors(fieldMap);
      } else {
        setTopError(err instanceof Error ? err.message : 'Registration failed');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCard
      eyebrow="Create account"
      title="Start a new project"
      description="One account drives every issue, agent, and chat across your projects."
    >
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
          autoFocus
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
          autoComplete="new-password"
          placeholder="••••••••"
          hint="8+ characters"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (fieldErrors.password) setFieldErrors((p) => ({ ...p, password: undefined }));
            if (fieldErrors.confirmPassword && e.target.value === confirmPassword) {
              setFieldErrors((p) => ({ ...p, confirmPassword: undefined }));
            }
          }}
          error={fieldErrors.password}
        />

        <Field
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          label="Confirm password"
          autoComplete="new-password"
          placeholder="••••••••"
          value={confirmPassword}
          onChange={(e) => {
            setConfirmPassword(e.target.value);
            if (fieldErrors.confirmPassword) setFieldErrors((p) => ({ ...p, confirmPassword: undefined }));
          }}
          error={fieldErrors.confirmPassword}
        />

        <PrimaryButton loading={loading} loadingLabel="Creating account…">
          Create account
        </PrimaryButton>
      </form>

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
