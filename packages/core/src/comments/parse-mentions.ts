const MENTION_RE = /(?:^|[^a-zA-Z0-9_.+-])@([a-zA-Z0-9_.+-]+)/g;

export function parseMentions(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of body.matchAll(MENTION_RE)) {
    const handle = match[1]?.toLowerCase().replace(/[.-]+$/, '');
    if (!handle) continue;
    if (seen.has(handle)) continue;
    seen.add(handle);
    out.push(handle);
  }
  return out;
}
