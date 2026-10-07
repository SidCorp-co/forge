import { apiClientList } from "@/lib/api/client";

/** One issue as the picker offers it: the key a write names it by, and the title a person knows it by. */
export interface IssuePick {
  key: string;
  title: string;
}

interface IssueSearchRow {
  displayId: string;
  title: string;
}

/** A text that reads as an issue key (`ISS-52`), which core retrieves exactly rather than by mention. */
const KEY_LIKE = /^[a-z][a-z0-9]*-\d+$/i;

const PICK_LIMIT = 8;

/**
 * The project's issues matching what a person typed: the issue a key names first, then those whose
 * title or body mentions the text, newest first. A key core cannot read is refused by name.
 */
export async function pickIssues(projectId: string, text: string): Promise<IssuePick[]> {
  const base = `/projects/${projectId}/issues/search?limit=${PICK_LIMIT}`;
  const [byKey, byText] = await Promise.all([
    KEY_LIKE.test(text)
      ? apiClientList<IssueSearchRow>(`${base}&key=${encodeURIComponent(text)}`)
      : Promise.resolve({ items: [] as IssueSearchRow[] }),
    apiClientList<IssueSearchRow>(`${base}&q=${encodeURIComponent(text)}`),
  ]);
  const seen = new Set<string>();
  return [...byKey.items, ...byText.items].flatMap((r) => {
    if (seen.has(r.displayId)) return [];
    seen.add(r.displayId);
    return [{ key: r.displayId, title: r.title }];
  });
}
