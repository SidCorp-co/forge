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
import type { ReplyLanguage } from '../../conversations/index.js';
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

/**
 * A refusal the model reads, and the sentence the person is told, already in the language they
 * asked in, so the reply relays it in that language rather than translating an English one.
 */
const refused = (code: ChatActRefusalCode, text: string, say?: string) =>
  toolError(
    `${code}: ${text} No button was offered.${say ? ` Tell the person, in these words: "${say}"` : ''}`,
  );

/** What each act is called, and what it applies to, in the asker's language. */
const ACT_WORDS: Record<ReplyLanguage, Record<ChatAct, { verb: string; from: string }>> = {
  en: {
    run: { verb: 'run', from: 'a draft, or an issue at open, approved or reopen' },
    continue: {
      verb: 'continued',
      from: 'an issue at needs_info or on_hold, or at open, approved or reopen',
    },
    drop: { verb: 'dropped', from: 'an issue that is not closed or dropped yet' },
    release: { verb: 'released', from: 'an issue at awaiting_release' },
  },
  vi: {
    run: { verb: 'chạy', from: 'issue ở draft, hoặc ở open, approved hay reopen' }, // i18n-allow: the person-facing refusal in the asker's language
    continue: {
      verb: 'tiếp tục', // i18n-allow: the person-facing refusal in the asker's language
      from: 'issue ở needs_info hay on_hold, hoặc ở open, approved hay reopen', // i18n-allow: the person-facing refusal in the asker's language
    },
    drop: { verb: 'bỏ', from: 'issue chưa closed hay dropped' }, // i18n-allow: the person-facing refusal in the asker's language
    release: { verb: 'phát hành', from: 'issue ở awaiting_release' }, // i18n-allow: the person-facing refusal in the asker's language
  },
};

const SAY = {
  en: {
    unknown: (key: string) => `${key} is not an issue in this project.`,
    reason: (key: string) => `Why should ${key} be dropped? The reason goes on the issue.`,
    status: (key: string, status: string, act: ChatAct) =>
      `${key} is at ${status}, so it cannot be ${ACT_WORDS.en[act].verb} from here: that applies to ${ACT_WORDS.en[act].from}.`,
    forbidden: (key: string, permission: string, act: ChatAct) =>
      `You do not hold ${permission} on this project, so ${key} cannot be ${ACT_WORDS.en[act].verb} by you; a project admin can.`,
  },
  vi: {
    unknown: (key: string) => `${key} không phải là issue nào trong project này.`, // i18n-allow: the person-facing refusal in the asker's language
    reason: (key: string) => `Vì sao cần bỏ ${key}? Lý do sẽ được ghi vào issue.`, // i18n-allow: the person-facing refusal in the asker's language
    status: (key: string, status: string, act: ChatAct) =>
      `${key} đang ở trạng thái ${status} nên không thể ${ACT_WORDS.vi[act].verb} từ đây: việc này chỉ áp dụng cho ${ACT_WORDS.vi[act].from}.`, // i18n-allow: the person-facing refusal in the asker's language
    forbidden: (key: string, permission: string, act: ChatAct) =>
      `Bạn chưa có quyền ${permission} trên project này nên không thể ${ACT_WORDS.vi[act].verb} ${key}; quản trị viên project có thể làm việc này.`, // i18n-allow: the person-facing refusal in the asker's language
  },
} as const;

interface Planned {
  effect: ChatActOffer['effect'];
  to?: IssueStatus;
  permission: ProjectPermission;
}

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
export function buildOfferActToolset(scope: {
  projectId: string;
  userId: string;
  /** The language the person asked in: the sentence a refusal hands the reply is in it. */
  language: ReplyLanguage;
}): ChatToolset {
  const say = SAY[scope.language];
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
          say.reason(key),
        );
      }
      let issueId: string;
      try {
        issueId = await resolveIssueKeyInProject(key, scope.projectId);
      } catch {
        return refused(
          'CHAT_ACT_ISSUE_UNKNOWN',
          `${key} names no issue in this project.`,
          say.unknown(key),
        );
      }
      const [row] = await db
        .select({ title: issues.title, status: issues.status })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.projectId, scope.projectId)))
        .limit(1);
      if (!row) {
        return refused(
          'CHAT_ACT_ISSUE_UNKNOWN',
          `${key} names no issue in this project.`,
          say.unknown(key),
        );
      }
      const status = row.status as IssueStatus;
      const planned = plan(act, status, await leftStatusOf(issueId));
      if (!planned) {
        return refused(
          'CHAT_ACT_NOT_FROM_STATUS',
          `${key} is at ${status}, and ${act} applies to ${ACT_WORDS.en[act].from}.`,
          say.status(key, status, act),
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
          `the person asking does not hold ${planned.permission} on this project, so ${act} on ${key} is not theirs to press.`,
          say.forbidden(key, planned.permission, act),
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
