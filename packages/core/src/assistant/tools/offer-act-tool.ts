// `offer_act`: the chat assistant offers to run, continue, drop or release an issue as a button in the
// thread, never as a redirect to another mode. Core reads the issue and the person's permission
// before offering, so a button is only ever one the person may press and one the issue's status
// allows; pressing it runs in the browser as the person, through the issue page's own route, which
// checks both again (`@forge/contracts/chat-acts`).

import {
  CHAT_ACT_TOOL,
  type ChatAct,
  type ChatActOffer,
  type ChatActRefusalCode,
  chatActParamsSchema,
} from '@forge/contracts/chat-acts';
import {
  ISSUE_TERMINAL_STATUSES,
  type IssueStatus,
  TAKEABLE_STATUSES,
} from '@forge/contracts/issue-machine';
import type { ProjectPermission } from '@forge/contracts/permissions';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import { issueWorkState } from '../../db/schema-issue-work-state.js';
import { resolveIssueKeyInProject } from '../../issues/index.js';
import { actorFor, can, projectResource } from '../../permissions/index.js';
import { type ChatToolset, toolError } from './mcp-adapter.js';

const DESCRIPTION = [
  'Offer the person a button in this conversation that runs, continues, drops or releases one issue.',
  'Use it when they ask for one of those acts, instead of telling them to open Agent mode or another screen.',
  'run: admit a draft into the pipeline, or start the next step of an issue at open, approved or reopen.',
  'continue: resume an issue parked at needs_info or on_hold where it left off, or start its next step.',
  'drop: the issue is not needed any more (what people mean by "close it, we do not need it"); reason is required, in their words.',
  'release: release an issue that is awaiting release (what people mean by "publish and close").',
  'Nothing changes until the person presses the button, and it runs with their own access. Say what the button will do.',
].join(' ');

const PERMISSION: Record<'admit' | 'write', ProjectPermission> = {
  admit: 'issues.admit',
  write: 'project.write',
};

const refused = (code: ChatActRefusalCode, text: string) =>
  toolError(`${code}: ${text} No button was offered.`);

interface Planned {
  effect: ChatActOffer['effect'];
  to?: IssueStatus;
  permission: ProjectPermission;
}

const ACT_FROM: Record<ChatAct, string> = {
  run: 'a draft, or an issue at open, approved or reopen',
  continue: 'an issue at needs_info or on_hold, or at open, approved or reopen',
  drop: 'any issue that is not closed or dropped yet',
  release: 'an issue at awaiting_release',
};

function plan(act: ChatAct, status: IssueStatus, left: IssueStatus | null): Planned | null {
  const step: Planned = { effect: 'run-step', permission: PERMISSION.write };
  switch (act) {
    case 'run':
      if (status === 'draft') return { effect: 'admit', to: 'open', permission: PERMISSION.admit };
      return TAKEABLE_STATUSES.includes(status) ? step : null;
    case 'continue':
      if (status === 'needs_info' || status === 'on_hold') {
        return left ? { effect: 'transition', to: left, permission: PERMISSION.write } : null;
      }
      return TAKEABLE_STATUSES.includes(status) ? step : null;
    case 'drop':
      return ISSUE_TERMINAL_STATUSES.includes(status)
        ? null
        : { effect: 'transition', to: 'dropped', permission: PERMISSION.write };
    case 'release':
      return status === 'awaiting_release'
        ? { effect: 'release', permission: PERMISSION.write }
        : null;
  }
}

async function leftStatusOf(issueId: string): Promise<IssueStatus | null> {
  const [row] = await db
    .select({ left: issueWorkState.leftStatus })
    .from(issueWorkState)
    .where(eq(issueWorkState.issueId, issueId))
    .limit(1);
  return (row?.left as IssueStatus | null | undefined) ?? null;
}

/** The toolset that offers acts on this project's issues to the person a turn answers. */
export function buildOfferActToolset(scope: { projectId: string; userId: string }): ChatToolset {
  return {
    tools: [
      {
        type: 'function',
        function: {
          name: CHAT_ACT_TOOL,
          description: DESCRIPTION,
          parameters: z.toJSONSchema(chatActParamsSchema, { io: 'input' }) as Record<
            string,
            unknown
          >,
        },
      },
    ],
    ranAs: () => scope.userId,
    async execute(_name, argsJson) {
      let raw: unknown;
      try {
        raw = argsJson.trim() ? JSON.parse(argsJson) : {};
      } catch {
        return refused('CHAT_ACT_INVALID', 'the arguments were not valid JSON.');
      }
      const params = chatActParamsSchema.safeParse(raw);
      if (!params.success) {
        const where = params.error.issues
          .map((i) => `${i.path.join('.') || '(params)'}: ${i.message}`)
          .join('; ');
        return refused('CHAT_ACT_INVALID', `${where}.`);
      }
      const { act, issue: key, reason } = params.data;
      if (act === 'drop' && !reason) {
        return refused(
          'CHAT_ACT_REASON_REQUIRED',
          'dropping an issue carries the reason the person gave; ask them why, or pass their words as reason.',
        );
      }
      let issueId: string;
      try {
        issueId = await resolveIssueKeyInProject(key, scope.projectId);
      } catch {
        return refused('CHAT_ACT_ISSUE_UNKNOWN', `${key} names no issue in this project.`);
      }
      const [row] = await db
        .select({ title: issues.title, status: issues.status })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.projectId, scope.projectId)))
        .limit(1);
      if (!row) return refused('CHAT_ACT_ISSUE_UNKNOWN', `${key} names no issue in this project.`);
      const status = row.status as IssueStatus;
      const planned = plan(act, status, await leftStatusOf(issueId));
      if (!planned) {
        return refused(
          'CHAT_ACT_NOT_FROM_STATUS',
          `${key} is at ${status}, and ${act} applies to ${ACT_FROM[act]}. Tell the person where it stands.`,
        );
      }
      const holds = await can(
        actorFor(scope.userId),
        planned.permission,
        projectResource(scope.projectId),
      );
      if (!holds) {
        return refused(
          'CHAT_ACT_FORBIDDEN',
          `the person asking does not hold ${planned.permission} on this project, so ${act} on ${key} is not theirs to press. Tell them who can.`,
        );
      }
      const offer: ChatActOffer = {
        v: 1,
        act,
        effect: planned.effect,
        projectId: scope.projectId,
        issueId,
        key,
        title: row.title,
        from: status,
        ...(planned.to ? { to: planned.to } : {}),
        ...(reason ? { reason } : {}),
      };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              offer,
              note: 'Shown to the person as a button in this conversation. Nothing has changed yet: it happens only when they press it, with their own access. Say what pressing it will do; do not say it is done.',
            }),
          },
        ],
      };
    },
  };
}
