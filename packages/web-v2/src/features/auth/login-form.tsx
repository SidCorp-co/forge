
import { useRouter } from "@/lib/navigation/router";
import { useState } from 'react';
import { Banner, Button, Field, Input } from '@/design';
import { formatApiError } from '@/lib/api/error';
import { useCopy } from '@/lib/i18n/interface-language';
import { SESSION_ENDED_LINE } from '@/lib/api/session-ended';
import { useAuth } from '@/providers/auth-provider';
import { extractFieldErrors } from './extract-field-errors';
import { validateLogin, type LoginFieldErrors, type LoginFieldKey } from './validation';

const FIELD_KEYS: readonly LoginFieldKey[] = ['email', 'password'];

export function LoginForm({
  presetEmail = '',
  sessionEnded: sentHere = false,
}: {
  presetEmail?: string;
  /** A server-side gate (the /admin one) met a session core refused and sent the person here. */
  sessionEnded?: boolean;
}) {
  const t = useCopy();
  const { login, sessionEnded: ended } = useAuth();
  const sessionEnded = ended || sentHere;
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
        setTopError(err instanceof Error ? formatApiError(err) : 'Sign in failed');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4" noValidate>
      {topError ? (
        <Banner tone="danger">{topError}</Banner>
      ) : (
        sessionEnded && (
          <p role="status" className="fg-body-sm text-muted">
            {SESSION_ENDED_LINE}
          </p>
        )
      )}

      <Field label={t('auth.field.email')} error={fieldErrors.email}>
        <Input
          type="email"
          icon="mail"
          autoComplete="email"
          inputMode="email"
          spellCheck={false}
          placeholder="you@studio.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (fieldErrors.email) setFieldErrors((p) => ({ ...p, email: undefined }));
          }}
        />
      </Field>

      <Field label={t('auth.field.password')} error={fieldErrors.password}>
        <Input
          type="password"
          icon="lock"
          autoComplete="current-password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (fieldErrors.password) setFieldErrors((p) => ({ ...p, password: undefined }));
          }}
        />
      </Field>

      <Button type="submit" variant="primary" loading={loading} className="mt-1 w-full">
        {t('auth.login.submit')}
      </Button>
    </form>
  );
}
