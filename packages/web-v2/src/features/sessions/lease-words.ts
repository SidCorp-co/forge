export function leaseDisagreementText(keys: readonly string[]): string | null {
  if (keys.length === 0) return null;
  const pronoun = keys.length === 1 ? "it" : "them";
  return `the box says it returned ${keys.join(", ")} · core still holds ${pronoun} · stop the session to free ${pronoun}`;
}
