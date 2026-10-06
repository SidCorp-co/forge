import { unanswered } from './channel-read.js';
import { unansweredView } from './channel-view.js';

/** What a project's channel owes a reply to, as its master is told it: each document by id and number. */
export async function unansweredDocuments(
  projectId: string,
): Promise<{ id: string; number: string | null }[]> {
  return unansweredView(await unanswered(projectId)).map((d) => ({ id: d.id, number: d.number }));
}
