export function projectDescriptionOf(document: unknown): string | null {
  const project = document && typeof document === "object" ? (document as { project?: unknown }).project : undefined;
  const v = project && typeof project === "object" ? (project as { description?: unknown }).description : undefined;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
