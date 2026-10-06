import { HTTPException } from 'hono/http-exception';
import { runWithPatScope } from '../credentials/pat-scope.js';
import { assertUnfenced } from './authz.js';
import {
  type GrantedTool,
  toolAccountWork,
  toolEpochRefusal,
  toolGrantRefusal,
} from './tool-grant.js';

interface ToolCallBound {
  readonly grant: readonly string[] | null | undefined;
  readonly fence: readonly string[] | null;
  readonly grantEpoch: number | undefined;
  readonly tokenId: string;
}

function accountRefusal(work: string | null, bound: ToolCallBound): string | null {
  if (work === null) return null;
  try {
    runWithPatScope({ projectIds: bound.fence, tokenId: bound.tokenId }, () =>
      assertUnfenced(work),
    );
    return null;
  } catch (err) {
    if (!(err instanceof HTTPException)) throw err;
    const code = (err.cause as { code?: string } | undefined)?.code;
    return `FORBIDDEN: ${code}: ${err.message}`;
  }
}

// reach, epoch and grant are read before any handler, in REST's order, by every door a
// tool is served through (/mcp and chat): a tool's role check alone would let a token granted
// `issues:read` call every tool its user's role allows, and a token fenced to one project do
// work belonging to none.
export function toolCallRefusal(
  tool: GrantedTool,
  args: Record<string, unknown>,
  bound: ToolCallBound,
  holder?: string,
): string | null {
  return (
    accountRefusal(toolAccountWork(tool, args), bound) ??
    toolEpochRefusal(tool, args, bound.grantEpoch) ??
    toolGrantRefusal(tool, args, bound.grant, holder)
  );
}
