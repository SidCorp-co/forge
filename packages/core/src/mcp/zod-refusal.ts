/** A tool input the schema refused, as one sentence naming each field and what is wrong with it. */
export function zodRefusalMessage(err: unknown): string | null {
  const issues = (err as { name?: unknown; issues?: unknown } | null)?.issues;
  if ((err as { name?: unknown } | null)?.name !== 'ZodError' || !Array.isArray(issues))
    return null;
  const lines = issues.map((issue: { path?: PropertyKey[]; message?: string }) => {
    const field = (issue.path ?? []).map(String).join('.');
    return field ? `\`${field}\`: ${issue.message}` : String(issue.message);
  });
  return `BAD_REQUEST: invalid arguments — ${lines.join('; ')}`;
}
