export function leaseDisagreementText(keys: readonly string[]): string | null {
  if (keys.length === 0) return null;
  const pronoun = keys.length === 1 ? "it" : "them";
  return `The box says it returned ${keys.join(", ")}. Core still holds ${pronoun}. Stop the session to free ${pronoun}.`;
}
