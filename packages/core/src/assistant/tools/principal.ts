import type { TurnCredential } from '../../credentials/turn-credential.js';
import type { ChatTurnFacts, McpContext } from '../../lib/tool.js';

/** A chat turn's tools run as the token minted for the person the turn answers (ISS-17). */
export function buildChatToolContext(opts: {
  credential: TurnCredential;
  projectSlug: string;
  /** The turn's room and linked speaker; omit on a turn that answers in no room. */
  turn?: ChatTurnFacts | undefined;
}): McpContext {
  const { principal } = opts.credential;
  return {
    principal,
    projectSlug: opts.projectSlug,
    boundProjectId: principal.boundProjectId,
    turnToken: opts.credential.token,
    grant: opts.credential.grant,
    fence: opts.credential.fence,
    ...(opts.turn ? { turn: opts.turn } : {}),
  };
}
