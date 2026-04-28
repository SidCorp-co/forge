'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { z } from 'zod';
import { useAuth } from '@/providers/auth-provider';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { extractFieldErrors } from '@/lib/api/extract-field-errors';
import { Field } from '../components/field';
import { PrimaryButton } from '../components/primary-button';

const loginSchema = z.object({
  email: z.string().trim().min(1, 'Email is required').email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});

type FieldKey = 'email' | 'password';
type FieldErrors = Partial<Record<FieldKey, string>>;
const FIELD_KEYS: readonly FieldKey[] = ['email', 'password'];

interface LoginFormProps {
  presetEmail?: string;
  /** Where to send the user after a successful sign-in. */
  redirectTo?: string;
}

export function LoginForm({ presetEmail = '', redirectTo = '/projects' }: LoginFormProps) {
  useSetPageTitle('Sign in');
  const { login } = useAuth();
  const router = useRouter();

  const [email, setEmail] = useState(presetEmail);
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [topError, setTopError] = useState('');
  const [loading, setLoading] = useState(false);

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
      router.push(redirectTo);
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
  );
}
