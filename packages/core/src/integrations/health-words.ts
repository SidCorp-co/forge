import { getIntegration } from './registry.js';
import type { HealthCheckResult } from './types.js';
import { isUnreachedReason, unreachedWords } from './unreached.js';

function asSentence(text: string): string {
  const t = text.trim();
  if (t === '') return '';
  const opened = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(opened) ? opened : `${opened}.`;
}

export function providerLabel(provider: string): string {
  return (
    getIntegration(provider)?.presentation?.label ??
    provider.charAt(0).toUpperCase() + provider.slice(1)
  );
}

/**
 * A check's answer as a person reads it: sentences Forge owns saying what the check found, and the
 * text the adapter or provider gave kept under `diagnostics.checkSaid` (ISS-1421 r14). Nothing is
 * put in the provider's mouth (r15): a check that never reached its host says why in Forge's words,
 * and one that failed some other way before an answer came says that, never "It said".
 */
export function healthAnswer(provider: string, result: HealthCheckResult): HealthCheckResult {
  const label = providerLabel(provider);
  const said = result.message?.trim() ?? '';
  const diagnostics = result.diagnostics ?? {};
  const lead: Record<HealthCheckResult['status'], string> = {
    ok: '',
    degraded: `${label} answered, but not fully.`,
    error: `Forge could not check ${label}.`,
    needs_reauth: `${label} refused the stored credential, so it needs signing in again.`,
    needs_scope: `${label} took the credential but it lacks a permission Forge needs.`,
  };
  // A lead naming the provider would claim the server at the person's own address is it (r18).
  if (diagnostics.saidOfAddress === true) {
    lead.needs_reauth = '';
    lead.needs_scope = '';
  }
  let message: string;
  if (result.status === 'ok') message = asSentence(said) || `${label} answered the check.`;
  else if (isUnreachedReason(diagnostics.unreached))
    message = unreachedWords(label, diagnostics.unreached);
  // The adapter worded which key was refused and until when the previous one runs (ISS-1421 r20).
  else if (diagnostics.newKeyRefused === true) message = asSentence(said);
  else if (diagnostics.thrown === true)
    message = `${lead[result.status]} The check failed, and what failed is kept in the diagnostics.`;
  else message = [lead[result.status], asSentence(said)].filter(Boolean).join(' ');
  return {
    ...result,
    message,
    ...(said ? { diagnostics: { ...result.diagnostics, checkSaid: said } } : {}),
  };
}
