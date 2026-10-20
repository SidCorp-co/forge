import { getIntegration } from './registry.js';
import type { HealthCheckResult } from './types.js';

function asSentence(text: string): string {
  const t = text.trim();
  if (t === '') return '';
  const opened = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(opened) ? opened : `${opened}.`;
}

/**
 * A check's answer as a person reads it: a sentence Forge owns saying what the check found, and
 * the text the adapter or provider gave kept under `diagnostics.checkSaid` (ISS-1421 r14).
 */
export function healthAnswer(provider: string, result: HealthCheckResult): HealthCheckResult {
  const label =
    getIntegration(provider)?.presentation?.label ??
    provider.charAt(0).toUpperCase() + provider.slice(1);
  const said = result.message?.trim() ?? '';
  const lead: Record<HealthCheckResult['status'], string> = {
    ok: '',
    degraded: `${label} answered, but not fully.`,
    error: `Forge could not check ${label}.`,
    needs_reauth: `${label} refused the stored credential, so it needs signing in again.`,
    needs_scope: `${label} took the credential but it lacks a permission Forge needs.`,
  };
  const message =
    result.status === 'ok'
      ? asSentence(said) || `${label} answered the check.`
      : [lead[result.status], said ? `It said: ${asSentence(said)}` : ''].filter(Boolean).join(' ');
  return {
    ...result,
    message,
    ...(said ? { diagnostics: { ...result.diagnostics, checkSaid: said } } : {}),
  };
}
