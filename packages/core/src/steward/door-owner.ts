// The steward names a requirement's owner where nobody owns it (REQ-48 BC-5, `no_owner`): its author,
// read from the requirement's first revision, never somebody the model picks. The owner door refuses
// an author who is no longer a member by name, and the act is undone by setting the owner back.

import { z } from 'zod';
import { type DoorAnswer, doorName } from './door-call.js';
import { cite, type DoorSpec, key, send } from './door-kit.js';

interface RequirementRead {
  id?: string;
  standing?: { owner?: { id: string } | null };
  revisions?: { revision: number; authorId: string }[];
}

/** The requirement's author: whoever wrote its first revision. */
function authorOf(read: RequirementRead): string | null {
  const first = [...(read.revisions ?? [])].sort((a, b) => a.revision - b.revision)[0];
  return first?.authorId ?? null;
}

const unread = (requirement: string, why: string): DoorAnswer => ({
  ok: false,
  status: 422,
  text: JSON.stringify({ code: 'STEWARD_OWNER_UNREAD', error: `${requirement}: ${why}` }),
  json: null,
});

const ownerParams = z.strictObject({ requirement: key });
export const OWNER: DoorSpec<z.infer<typeof ownerParams>> = {
  name: 'steward_set_requirement_owner',
  describe:
    "Name a requirement's author as its owner, where nobody owns it (stuck no_owner). Only the author is ever named.",
  params: ownerParams,
  write: true,
  async call(args, ctx) {
    const path = `/api/projects/${ctx.projectId}/requirements/${args.requirement}`;
    const read = await send({ method: 'GET', path }, ctx);
    if (!read.answer.ok) return read;
    const requirement = read.answer.json as RequirementRead | null;
    const author = requirement ? authorOf(requirement) : null;
    if (!author) {
      return {
        request: read.request,
        answer: unread(args.requirement, 'it has no revision, so no author to own it'),
      };
    }
    const before = requirement?.standing?.owner?.id ?? null;
    if (before !== null) {
      return {
        request: read.request,
        answer: unread(
          args.requirement,
          `it is owned already (${before}); the steward names an owner only where nobody owns it`,
        ),
      };
    }
    const sent = await send({ method: 'PATCH', path, body: { owner: author } }, ctx);
    return {
      ...sent,
      act: {
        door: doorName(sent.request),
        did: `Named the author of ${args.requirement} as its owner`,
        wrote: cite('requirement', args.requirement),
        undo: { door: `PATCH ${path}`, body: { owner: before } },
      },
    };
  },
};
