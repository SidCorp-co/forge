'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner, Button, Field, Input } from '@/design';
import { useAuth } from '@/providers/auth-provider';
import { extractFieldErrors } from './extract-field-errors';
import { validateLogin, type LoginFieldErrors, type LoginFieldKey } from './validation';

const FIELD_KEYS: readonly LoginFieldKey[] = ['email', 'password'];

export function LoginForm({ presetEmail = '' }: { presetEmail?: string }) {
  const { login } = useAuth();
  const router = useRouter();

  const [email, setEmail] = useState(presetEmail);
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<LoginFieldErrors>({});
  const [topError, setTopError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTopError('');
    const errs = validateLogin({ email, password });
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    setLoading(true);
    try {
      await login({ email: email.trim(), password });
      // basePath-relative — resolves to the /v2 workspace shell.
      router.push('/');
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
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      {topError && <Banner tone="danger">{topError}</Banner>}

      <Field label="Email" error={fieldErrors.email}>
        <Input
          type="email"
          icon="mail"
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
        />
      </Field>

      <Field label="Password" error={fieldErrors.password}>
        <Input
          type="password"
          icon="lock"
          autoComplete="current-password"
          placeholder="••••••••"
          autoFocus={!!presetEmail}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (fieldErrors.password) setFieldErrors((p) => ({ ...p, password: undefined }));
          }}
        />
      </Field>

      <Button type="submit" variant="primary" loading={loading} className="mt-1 w-full">
        Sign in
      </Button>
    </form>
  );
}
