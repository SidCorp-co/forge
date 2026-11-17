// A dialog the runner read on a resident session and answered itself (ISS-1268 C2): one that slipped
// past the session's permission relay, or a startup dialog. The runner answers it within one watcher
// cycle, from its dialog catalog or the safe way (Escape), and tells Forge here: the project's admins
// are rung with the session, the dialog's text as read, what the session says it needs, and the
// answer. Never silent, and an unknown dialog becomes the catalog's next entry from this notice.

import { emitNotification } from './emit.js';
import { projectAdminUserIds } from './project-admins.js';

/** What the runner read and did, as its device door validated it. */
export interface SessionPromptRaised {
  projectId: string;
  session: string;
  text: string;
  needs: string | null;
  /** `catalog`: the dialog was known to the pinned version; `safe`: unknown, Escape; `unread`: no key pressed. */
  by: 'catalog' | 'safe' | 'unread';
  answer: string;
}

const TITLE_MAX = 300;

/** The notice's title: the session, what it stood on, and what the runner did. */
export function sessionPromptTitle(r: SessionPromptRaised): string {
  const firstLine = r.text.split('\n').find((l) => l.trim()) ?? 'a dialog';
  const did =
    r.by === 'unread'
      ? `the runner could not read it (${r.answer}) and pressed nothing`
      : `the runner answered ${r.answer}${r.by === 'catalog' ? ' from its dialog catalog' : ', the safe answer to a dialog it does not know'}`;
  const title = `${r.session} stood on «${firstLine.trim()}»: ${did}`;
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title;
}

/** Rings the project's admins; `nobody` where the project has none. */
export async function tellSessionPrompt(r: SessionPromptRaised): Promise<'told' | 'nobody'> {
  const recipients = await projectAdminUserIds(r.projectId);
  if (recipients.length === 0) return 'nobody';
  await emitNotification({
    recipients,
    projectId: r.projectId,
    type: 'session_prompt_answered',
    title: sessionPromptTitle(r),
    body: [r.text, r.needs ? `Needs: ${r.needs}` : null].filter(Boolean).join('\n\n'),
  });
  return 'told';
}
