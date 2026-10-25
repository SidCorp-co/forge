// `offer_item_act`: the chat offers a Product act on a requirement, a feedback item, a workflow design
// or a release as a card in the thread (REQ-69 BC-3, BC-4), never as a redirect to the item's page.
// Core reads the item as the person (`item-act-plans.ts`) before offering, so a card is only ever one
// the item's state allows and the person may press; the text it would save is checked against the
// project's language first (BC-10); a triage that would file an issue is refused (BC-7). Pressing it
// runs in the browser as the person, through the item page's own route, which checks it all again.

import { contentLanguageMisfit, contentLanguageName } from '@forge/contracts/content-language';
import {
  ITEM_ACT_TOOL,
  ITEM_ACTS,
  type ItemAct,
  type ItemActOffer,
  type ItemActParams,
  type ItemActRefusalCode,
  type ItemActTriage,
  itemActKind,
  itemActParamsSchema,
} from '@forge/contracts/item-acts';
import { WORKFLOW_PAGE_REF } from '@forge/contracts/ui-actions';
import { z } from 'zod';
import { readContentLanguage } from '../../project-config/index.js';
import { planItemAct } from './item-act-plans.js';
import { type ChatToolset, toolError } from './mcp-adapter.js';

const DESCRIPTION = [
  'Offer the person a card in this conversation that does one Product act on an item, as they would on its page:',
  'a requirement (REQ-n): propose its draft revision, agree it, accept or return its proposed revision, defer, undefer, drop, or accept its delivery;',
  'feedback (FB-n): triage it to an existing issue, a new or draft requirement, an answer, a duplicate, or decline it;',
  'a workflow design (its flow): propose its draft, approve or return the revision awaiting its approver;',
  'a release (its version): cut it, approve it or return it.',
  'Use it when they ask for one of those acts, instead of telling them to open the page.',
  "Before calling it, say what you understood and what the card will record where; a reason is the person's words, written in the project's language.",
  'Nothing changes until the person presses the card, and it runs with their own access. Never say it is done; never file an issue this way.',
].join(' ');

const KEY_OF_KIND = {
  requirement: [/^REQ-\d{1,9}$/, 'a requirement key such as REQ-30'],
  feedback: [/^FB-\d{1,9}$/, 'a feedback key such as FB-12'],
  workflow: [WORKFLOW_PAGE_REF, "a workflow's flow such as chat-turn"],
  release: [/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/, 'a release version such as 0.4.0-dev.217'],
} as const;

const TRIAGE_FIELDS = [
  'route',
  'issue',
  'requirement',
  'title',
  'answer',
  'duplicateOf',
  'note',
] as const;

const refused = (code: ItemActRefusalCode, text: string) =>
  toolError(`${code}: ${text} No card was offered.`);

/** What a triage carries for its route, or the refusal naming what the route needs. */
function triageOf(p: ItemActParams): ItemActTriage | { code: ItemActRefusalCode; why: string } {
  const need = (field: string, why: string) => ({
    code: 'ITEM_ACT_INVALID' as const,
    why: `route ${p.route} needs ${field}: ${why}.`,
  });
  switch (p.route) {
    case undefined:
      return { code: 'ITEM_ACT_INVALID', why: 'feedback.triage needs route.' };
    case 'issue':
      if (!p.issue)
        return {
          code: 'ITEM_ACT_FILES_ISSUE',
          why: 'route issue with no issue would file a new issue, and a chat never files one (REQ-69 BC-7); name the existing issue that carries it, or route it to a requirement',
        };
      break;
    case 'new_requirement':
      if (!p.requirement && !p.title)
        return need(
          'requirement or title',
          'the draft it joins, or the title of the one it starts',
        );
      break;
    case 'answer':
      if (!p.answer) return need('answer', 'what the reporter is told');
      break;
    case 'duplicate':
      if (!p.duplicateOf) return need('duplicateOf', 'the feedback it repeats');
      break;
    case 'decline':
      if (!p.note) return need('note', 'the reason, which the reporter reads');
      break;
  }
  const triage: Record<string, string> = {};
  for (const f of TRIAGE_FIELDS) if (p[f] !== undefined) triage[f] = p[f] as string;
  return triage as ItemActTriage;
}

/** The call's shape against its act: a reason where one is owed, triage fields only on a triage. */
function shapeRefusal(p: ItemActParams): [ItemActRefusalCode, string] | null {
  const kind = itemActKind(p.act);
  const [pattern, example] = KEY_OF_KIND[kind];
  if (!pattern.test(p.key))
    return ['ITEM_ACT_INVALID', `${p.act} names a ${kind} by ${example}, not "${p.key}".`];
  const rule = ITEM_ACTS[p.act].reason;
  if (rule === 'required' && !p.reason)
    return [
      'ITEM_ACT_REASON_REQUIRED',
      `${p.act} carries the person's reason, as its page asks; ask them why, or pass their words as reason.`,
    ];
  if (rule === 'none' && p.reason)
    return ['ITEM_ACT_INVALID', `${p.act} takes no reason; leave reason out.`];
  const stray = TRIAGE_FIELDS.filter((f) => p[f] !== undefined);
  if (p.act !== 'feedback.triage' && stray.length > 0)
    return [
      'ITEM_ACT_INVALID',
      `${stray.join(', ')} belong to feedback.triage only; leave them out of ${p.act}.`,
    ];
  return null;
}

/** The first text the card would save that is plainly not in the project's language, as a refusal. */
async function languageRefusal(projectId: string, p: ItemActParams): Promise<string | null> {
  const { contentLanguage: tag } = await readContentLanguage(projectId);
  for (const field of ['reason', 'note', 'answer', 'title'] as const) {
    const text = p[field];
    const misfit = text ? contentLanguageMisfit(tag, text) : null;
    if (misfit)
      return `${field} would be saved on the item, but ${misfit}. Write it in ${contentLanguageName(tag)}, keeping the person's meaning, and offer the card again.`;
  }
  return null;
}

/** What pressing the card does, in one sentence the reply restates (BC-4). */
function saidOf(offer: ItemActOffer): string {
  const r = offer.revision ? ` revision ${offer.revision}` : '';
  const where = `on ${offer.key}`;
  const words: Record<ItemAct, string> = {
    'requirement.propose': `proposes ${offer.key}${r} to its signer`,
    'requirement.agree': `agrees ${offer.key}${r}, recording the reason on its history`,
    'requirement.accept': `accepts the proposed${r} ${where}`,
    'requirement.return': `returns the proposed${r} ${where} with the reason`,
    'requirement.defer': `defers ${offer.key} with the reason`,
    'requirement.undefer': `brings ${offer.key} back from deferred with the reason`,
    'requirement.drop': `drops ${offer.key} with the reason`,
    'requirement.accept_delivery': `accepts the delivery of ${offer.key}${r}`,
    'feedback.triage': `triages ${offer.key} to ${offer.triage?.route ?? 'its route'}`,
    'workflow.propose': `proposes ${offer.key}'s design${r} to its approver`,
    'workflow.approve': `approves ${offer.key}'s design${r}`,
    'workflow.return': `returns ${offer.key}'s design${r} with the reason`,
    'release.cut': `cuts release ${offer.key} with ${offer.issueKeys?.length ?? 0} issue(s)`,
    'release.approve': `approves release ${offer.key} to ship, with the reason`,
    'release.return': `returns release ${offer.key} with the reason`,
  };
  return `Pressing it ${words[offer.act]}.`;
}

/** The toolset that offers Product acts on this project's items to the person a turn answers. */
export function buildOfferItemActToolset(scope: {
  projectId: string;
  userId: string;
}): ChatToolset {
  return {
    tools: [
      {
        type: 'function',
        function: {
          name: ITEM_ACT_TOOL,
          description: DESCRIPTION,
          parameters: z.toJSONSchema(itemActParamsSchema, { io: 'input' }) as Record<
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
        return refused('ITEM_ACT_INVALID', 'the arguments were not valid JSON.');
      }
      const parsed = itemActParamsSchema.safeParse(raw);
      if (!parsed.success) {
        const where = parsed.error.issues
          .map((i) => `${i.path.join('.') || '(params)'}: ${i.message}`)
          .join('; ');
        return refused('ITEM_ACT_INVALID', `${where}.`);
      }
      const p = parsed.data;
      const shape = shapeRefusal(p);
      if (shape) return refused(...shape);
      const triage = p.act === 'feedback.triage' ? triageOf(p) : null;
      if (triage && 'code' in triage) return refused(triage.code, triage.why);
      const unsaid = await languageRefusal(scope.projectId, p);
      if (unsaid) return refused('ITEM_ACT_NOT_IN_PROJECT_LANGUAGE', unsaid);
      const read = await planItemAct(p.act, p.key, scope);
      if (!read.ok) return refused(read.refused.code, read.refused.why);
      const offer: ItemActOffer = {
        v: 1,
        act: p.act,
        projectId: scope.projectId,
        ...read.plan,
        ...(p.reason ? { reason: p.reason } : {}),
        ...(triage ? { triage } : {}),
      };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              offer,
              said: saidOf(offer),
              note: 'Shown to the person as a card in this conversation. Nothing has changed yet: it happens only when they press it, with their own access, and the card then shows the new state or why it failed. Restate what it records and where, using said; do not say it is done.',
            }),
          },
        ],
      };
    },
  };
}
