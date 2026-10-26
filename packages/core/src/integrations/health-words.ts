import { PROVIDER_LABELS } from '@forge/contracts/health-words';
import type { HealthCheckResult, IntegrationProvider } from './types.js';
import { isUnreachedReason, unreachedHostOf, unreachedWords } from './unreached.js';

function asSentence(text: string): string {
  const t = text.trim();
  if (t === '') return '';
  const opened = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(opened) ? opened : `${opened}.`;
}

const LABELS: Readonly<Record<IntegrationProvider, string>> = PROVIDER_LABELS;

export function providerLabel(provider: string): string {
  return LABELS[provider as IntegrationProvider] ?? provider;
}

/** Providers in a sentence, each as the Integrations page labels it: "Coolify, Epodsystem and Sentry". */
export function labelsInWords(providers: readonly string[]): string {
  const words = providers.map(providerLabel);
  return words.length < 2
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** The values a caller sends for providers, each beside its label: "`coolify` (Coolify), …". */
export function providerValuesInWords(providers: readonly string[]): string {
  return providers.map((p) => `\`${p}\` (${providerLabel(p)})`).join(', ');
}

/** A connection as a sentence names it: by the name its owner gave it, never by its id. */
export function connectionCalled(connection: {
  displayName: string | null;
  provider: string;
}): string {
  const prefix = `${connection.provider} · `;
  const given = connection.displayName?.startsWith(prefix)
    ? connection.displayName.slice(prefix.length)
    : connection.displayName;
  return given?.trim()
    ? `the connection "${given.trim()}"`
    : `this ${providerLabel(connection.provider)} connection`;
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
    message = unreachedWords(label, diagnostics.unreached, unreachedHostOf(diagnostics));
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
