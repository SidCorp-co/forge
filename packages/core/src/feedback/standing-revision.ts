/** The act a revision-routed item's wait names on its revision (`standing.ts:revisionWait`). */

import { type Said, say } from '@forge/contracts/said';

/** `accept revision 2 of REQ-4`, `propose the revision`: the act on a revision, by what is known of it. */
export function revisionAct(
  verb: 'accept' | 'propose',
  revision: { revision: number | null; requirement: string | null },
): Said {
  const { revision: r, requirement: req } = revision;
  if (verb === 'accept') {
    if (r === null) {
      return req
        ? say('standing.act.acceptRevisionOf', { req })
        : say('standing.act.acceptRevision');
    }
    return req
      ? say('standing.act.acceptRevisionN', { r, req })
      : say('standing.act.acceptRevisionNum', { r });
  }
  if (r === null) {
    return req
      ? say('standing.act.proposeRevisionOf', { req })
      : say('standing.act.proposeRevision');
  }
  return req
    ? say('standing.act.proposeRevisionN', { r, req })
    : say('standing.act.proposeRevisionNum', { r });
}
