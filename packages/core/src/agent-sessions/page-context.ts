import { z } from 'zod';

// Bubble panel auto-injects which page (and which issue) the user is on so the
// agent can ground its replies without the user typing "ISS-XX" by hand. Shared
// by the REST routes and the single chat-turn dispatcher.
export const pageContextSchema = z
  .object({
    page: z.string().min(1).max(40),
    issueId: z.uuid().optional(),
    issueDisplayId: z.string().max(40).optional(),
    issueTitle: z.string().max(500).optional(),
    issueStatus: z.string().max(40).optional(),
  })
  .strict();

export type PageContext = z.infer<typeof pageContextSchema>;

export function formatPageContextLine(ctx: PageContext): string {
  const sanitize = (s: string) => s.replace(/[\r\n\]]/g, ' ').replace(/'/g, '');
  const parts: string[] = [`page=${sanitize(ctx.page)}`];
  if (ctx.issueDisplayId) parts.push(sanitize(ctx.issueDisplayId));
  if (ctx.issueTitle) parts.push(`'${sanitize(ctx.issueTitle)}'`);
  if (ctx.issueStatus) parts.push(`status=${sanitize(ctx.issueStatus)}`);
  return `[Context: ${parts.join(' ')}]`;
}

// Re-validate persisted pageContext on read — corrupt jsonb rows could feed
// garbage into samePageContext / formatPageContextLine. safeParse failure is
// treated as "no prior context" so the next turn re-prepends the header.
export function readPersistedPageContext(value: unknown): PageContext | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = pageContextSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function samePageContext(a: PageContext | null | undefined, b: PageContext): boolean {
  if (!a) return false;
  if (a.page !== b.page) return false;
  // If both sides have an issueId, they must match. When one side is missing
  // (the issue query hadn't resolved yet on the previous turn, or this turn),
  // treat the same page as a match — otherwise we'd echo the [Context: …] line
  // every time the issue data races into place.
  if (a.issueId && b.issueId) return a.issueId === b.issueId;
  return true;
}
