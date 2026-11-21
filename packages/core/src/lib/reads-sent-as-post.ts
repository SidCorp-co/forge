// The POST routes that are reads (ISS-1400): a search sends its query as a body and writes nothing.
// Two doors read this list and nothing else decides it: the token gate levels these requests `read`
// for the grant they want and the scope they need (`middleware/pat-rest-surface.ts:patLevelFor`),
// and the chat credential's write rule passes them as not a business write
// (`assistant/agreement/write-rule.ts:NOT_A_BUSINESS_WRITE`). A search route added here is a read at
// both. A preview or a report run is not a search and stays a write at the token gate.

/** Each read sent as a POST, as `POST /pattern` with the route's own `:param` segments. */
export const READS_SENT_AS_POST = [
  'POST /api/memory/search',
  'POST /api/projects/:id/knowledge/search',
] as const;

const SHAPES = READS_SENT_AS_POST.map((call) => call.slice('POST '.length).split('/'));

/** Whether this request is one the list names: the whole path against the pattern, never a prefix. */
export function isReadSentAsPost(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  const have = path.split('/');
  return SHAPES.some(
    (want) =>
      want.length === have.length &&
      want.every((seg, i) => (seg.startsWith(':') ? (have[i] ?? '') !== '' : seg === have[i])),
  );
}
