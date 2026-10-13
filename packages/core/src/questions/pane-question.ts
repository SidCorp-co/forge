/**
 * A question a job pane stopped on, shaped to the tracker's question model.
 *
 * What the pane asked is another agent's text, and the question screen exists to refuse text that
 * breaks lines, opens like an option number, addresses a room or carries a secret. So each part is
 * made one line with secrets redacted before it is written, and a question the screen still
 * refuses is carried as a free-text question naming the rule, never dropped.
 */

import { scrubLogText } from '@forge/observability';
import type { PaneAsk } from '../jobs/blocked-wire.js';
import { OPTION_LINE_RE } from '../messaging/option-line.js';
import type { AskAnswer } from './write.js';

export interface PaneQuestion {
  prompt: string;
  answer: AskAnswer;
}

const PROMPT_MAX = 3000;
const LABEL_MAX = 480;
const PERMISSION_INPUT_MAX = 1500;
const BROADCAST_RE = /(^|\s)@(all|here|channel)\b/gi;

type DialogQuestion = Extract<PaneAsk, { kind: 'dialog' }>['questions'][number];

/** One line, redacted, shortened, and shaped so no screen rule reads it as something it is not. */
export function oneLine(text: string, max: number): string {
  const flat = scrubLogText(text).replace(/\s+/g, ' ').replace(BROADCAST_RE, '$1(at $2)').trim();
  const cut = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  if (cut === '') return '(blank)';
  return OPTION_LINE_RE.test(cut) ? `Choice: ${cut}` : cut;
}

function recommendedOf(labels: readonly string[]): number {
  const marked = labels.findIndex((label) => /\(recommended\)/i.test(label));
  return marked >= 0 ? marked : 0;
}

function dialogQuestion(q: DialogQuestion): PaneQuestion {
  const head = q.header ? `${oneLine(q.header, 100)}: ` : '';
  const prompt = `${head}${oneLine(q.question, PROMPT_MAX)}`;
  const labels = q.options.map((o) =>
    oneLine(o.description ? `${o.label} — ${o.description}` : o.label, LABEL_MAX),
  );
  if (!q.multiSelect && labels.length >= 2) {
    return {
      prompt,
      answer: {
        shape: 'choice',
        options: labels.map((label, i) => ({
          id: `o${i + 1}`,
          label,
          authority: 'writer' as const,
          bindsTo: 'session' as const,
          executedBy: 'agent' as const,
        })),
        recommendedOptionId: `o${recommendedOf(labels) + 1}`,
      },
    };
  }
  const offered = labels.length > 0 ? ` Options offered: ${labels.join(' | ')}.` : '';
  return {
    prompt: `${prompt}${offered}`,
    answer: {
      shape: 'free_text',
      needed: q.multiSelect
        ? 'which of the options apply, or what else the agent should do'
        : 'your answer to this question',
    },
  };
}

const READ_IN_SESSION = "Its session on that box holds the question's own words.";
const NEEDED_UNREAD = 'what the agent should do, or your answer to what it asked';

/** What one pane's stop becomes: a question per dialog question, or one that says what was lost. */
export function paneQuestions(asked: PaneAsk, who: string): PaneQuestion[] {
  if (asked.kind === 'dialog') return asked.questions.map(dialogQuestion);
  if (asked.kind === 'permission') {
    const call = oneLine(asked.input, PERMISSION_INPUT_MAX);
    return [
      {
        prompt: `The ${who} stopped to ask permission to use ${oneLine(asked.tool, 100)}: ${call}`,
        answer: {
          shape: 'free_text',
          needed: 'whether it may make this call, or what it should do instead',
        },
      },
    ];
  }
  return [
    {
      prompt: `The ${who} stopped on a question this box could not read: ${oneLine(asked.why, 500)}. ${READ_IN_SESSION}`,
      answer: { shape: 'free_text', needed: NEEDED_UNREAD },
    },
  ];
}

/** The rule ids a screen refusal's message names, each once. */
export function rulesOf(message: string): string[] {
  return [...new Set([...message.matchAll(/rule: ([\w-]+)/g)].map((m) => m[1] as string))];
}

/** The question carried in place of one the screen refused. */
export function refusedPaneQuestion(who: string, rules: readonly string[]): PaneQuestion {
  const named = rules.length > 0 ? rules.join(', ') : 'the question screen';
  return {
    prompt: `The ${who} stopped on a question this tracker would not carry as written (${named}). ${READ_IN_SESSION}`,
    answer: { shape: 'free_text', needed: NEEDED_UNREAD },
  };
}
