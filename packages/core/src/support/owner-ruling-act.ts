// A project admin's ruling for a production act, given in a room and recorded on the issue as his
// (REQ-80 BC-11, ISS-1431): the owner's spoken order in adminhub-fe ISS-164 to set a protected key had
// no way to become the ruling a run reads, since an agent-written decision is no ruling by design. Who said
// it is the chat server's record of his message (`owner-forge-act.ts:ownerOfMessage`), never the
// session's word; his own account must hold project.admin, as `variables-rules.ts:rulingRead` asks of
// a ruling's writer. The record is the issue events door's own `decision` (`writeScreenedRecordEvent`),
// written by him as a person with his message quoted in `why`, so the run's read counts it exactly as
// one he wrote on the issue page. It is refused, nothing recorded, for an environment that is not one
// of the project's production-tier ones and for an issue no ruling can hold on (closed or dropped).

import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { RULING_ENVIRONMENT_FIELD } from '@forge/contracts/record-events';
import type { SupportForgeActRequest } from '@forge/contracts/support-channel';
import { listIssues, writeScreenedRecordEvent } from '../issues/index.js';
import { actorFor, permissionRefusalFor, projectResource } from '../permissions/index.js';
import { declaredEnvironments } from '../project-config/index.js';
import type { OpsOutcome } from './ops-types.js';
import { no } from './outcome.js';

/** Record his ruling on `input.item` as `at.userId`, a person, its `why` quoting his message. */
export async function recordProductionRuling(
  input: SupportForgeActRequest,
  why: string | undefined,
  at: { projectId: string; userId: string },
): Promise<OpsOutcome<{ key: string; recorded: string }>> {
  const ruling = input.ruling;
  if (!ruling)
    throw new Error('owner-ruling-act: issue.rule_production reached its write with no ruling');
  const refused = await permissionRefusalFor(
    actorFor(at.userId),
    'project.admin',
    projectResource(at.projectId),
    'giving a ruling for a production act',
  );
  if (refused) {
    return {
      ok: false,
      refusals: [
        {
          code: refused.code,
          path: '/act',
          detail: `${refused.detail}. A ruling for a production act is a project admin's: nothing was recorded; tell them one of the project's admins gives it, here or on the issue's page`,
        },
      ],
    };
  }
  const environments = await declaredEnvironments(at.projectId);
  const production = environments.filter((e) => e.tier === 'production').map((e) => e.name);
  const named = environments.find((e) => e.name === ruling.environment);
  if (named?.tier !== 'production') {
    return no(
      'SUPPORT_RULING_NOT_PRODUCTION',
      '/ruling/environment',
      `\`${ruling.environment}\` is ${named ? `a ${named.tier}-tier environment of this project` : 'no environment this project declares'}, and a ruling opens only a production-tier one's protected variables: ${production.length > 0 ? `name ${production.map((n) => `\`${n}\``).join(' or ')}` : 'this project declares none, so there is nothing to rule on'}. Nothing was recorded`,
    );
  }
  const listed = await listIssues(
    at.projectId,
    { key: input.item },
    { sort: 'updatedAt:desc', limit: 1, offset: 0 },
  );
  if (!listed.ok) {
    return no(
      'OPS_ISSUE_UNKNOWN',
      '/item',
      `${listed.message.replace(/\.?$/, '.')} Nothing was recorded`,
    );
  }
  const issue = listed.rows[0];
  if (!issue) {
    return no(
      'OPS_ISSUE_UNKNOWN',
      '/item',
      `this project holds no issue ${input.item}. Nothing was recorded`,
    );
  }
  if ((ISSUE_TERMINAL_STATUSES as readonly string[]).includes(issue.status)) {
    return no(
      'SUPPORT_RULING_ISSUE_CLOSED',
      '/item',
      `${input.item} is ${issue.status}, and a ruling holds only while its issue is open: rule on the open issue the run works. Nothing was recorded`,
    );
  }
  const event = await writeScreenedRecordEvent({
    projectId: at.projectId,
    issueId: issue.id,
    // his own word from his own message: a person's ruling, never the agent that relayed it
    actor: { type: 'user', id: at.userId, agency: 'human' },
    kind: 'decision',
    contract: 1,
    fields: [
      { key: 'decision', value: ruling.act },
      { key: RULING_ENVIRONMENT_FIELD, value: named.name },
      ...(why ? [{ key: 'why', value: why }] : []),
    ],
  });
  return {
    ok: true,
    value: {
      key: input.item,
      recorded: `his ruling for ${named.name} on ${input.item}, decision ${event.id}: a run working ${input.item} reads ${named.name}'s protected variables while it is open`,
    },
  };
}
