'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner, Button, Field, Input } from '@/design';
import { useAuth } from '@/providers/auth-provider';
import { PasswordMeter } from './components/password-meter';
import { extractFieldErrors } from './extract-field-errors';
import { validateRegister, type RegisterFieldErrors } from './validation';

// The server only validates email + password; confirmPassword is client-only.
const SERVER_FIELD_KEYS = ['email', 'password'] as const;

export function RegisterForm() {
  const { register } = useAuth();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<RegisterFieldErrors>({});
  const [topError, setTopError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTopError('');
    const errs = validateRegister({ email, password, confirmPassword });
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    setLoading(true);
    try {
      await register({ email: email.trim(), password });
      // Registration does not sign the user in — hand the email forward so
      // /login can prefill + show the success banner. `replace` keeps the back
      // button useful.
      router.replace(`/login?registered=1&email=${encodeURIComponent(email.trim())}`);
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
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      {topError && <Banner tone="danger">{topError}</Banner>}

      <Field label="Email" error={fieldErrors.email}>
        <Input
          type="email"
          icon="mail"
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
        />
      </Field>

      <Field label="Password" error={fieldErrors.password} hint="8+ characters">
        <Input
          type="password"
          icon="lock"
          autoComplete="new-password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (fieldErrors.password) setFieldErrors((p) => ({ ...p, password: undefined }));
            if (fieldErrors.confirmPassword && e.target.value === confirmPassword) {
              setFieldErrors((p) => ({ ...p, confirmPassword: undefined }));
            }
          }}
        />
      </Field>
      <PasswordMeter password={password} />

      <Field label="Confirm password" error={fieldErrors.confirmPassword}>
        <Input
          type="password"
          icon="lock"
          autoComplete="new-password"
          placeholder="••••••••"
          value={confirmPassword}
          onChange={(e) => {
            setConfirmPassword(e.target.value);
            if (fieldErrors.confirmPassword)
              setFieldErrors((p) => ({ ...p, confirmPassword: undefined }));
          }}
        />
      </Field>

      <Button type="submit" variant="primary" loading={loading} className="mt-1 w-full">
        Create account
      </Button>
    </form>
  );
}
