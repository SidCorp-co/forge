import type { TurnCredential } from '../../auth/turn-credential.js';
import type { ChatTurnFacts, McpContext } from '../../mcp/tools/lib.js';
import type { McpPrincipal } from '../../middleware/require-pat.js';

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
    ...(opts.turn ? { turn: opts.turn } : {}),
  };
}

const NO_AUTHORITY =
  'this context was built to measure the tool catalog and acts as nobody; a turn runs under the token minted for the person it answers';

/**
 * A context the catalog can be BUILT from and nothing can be run in: every read of its
 * principal throws, so a handler invoked here fails by name rather than acting as someone.
 */
export function catalogOnlyContext(projectId: string, projectSlug: string): McpContext {
  const principal = new Proxy({} as McpPrincipal, {
    get: () => {
      throw new Error(NO_AUTHORITY);
    },
  });
  return { principal, projectSlug, boundProjectId: projectId, grant: null };
}
