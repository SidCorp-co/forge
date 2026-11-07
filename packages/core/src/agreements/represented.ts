// Agreements a project already writes elsewhere (REQ-90 BC-4, BC-12), read from the place that holds
// them as it stands, never copied: the gate profile and overrides (the project document's `gates`,
// REQ-76), the content language (the project document, REQ-13), and who agrees to an act (a ruling
// naming deciders, ISS-1042). Each is changed only through its own door, which the view names.

import type { AgreementRevisionView } from '@forge/contracts/agreements';
import { contentLanguageName } from '@forge/contracts/content-language';
import {
  ANY_ROOM_MEMBER,
  CHANNEL_DECIDER_ACT_LABEL,
  type RulingDecider,
} from '@forge/contracts/support-channel';
import type { RulingDeciderRead } from '../knowledge/index.js';
import type { GateChangeView } from '../project-config/index.js';
import type { RepresentedAgreement } from './resolve.js';

export const GATE_PROFILE_SLUG = 'gate-profile';
export const CONTENT_LANGUAGE_SLUG = 'content-language';
/** A ruling naming deciders reads as the agreement `who-agrees-<ruling slug>`. */
export const WHO_AGREES_PREFIX = 'who-agrees-';

const SEEDED_AT = new Date('2026-11-07T00:00:00Z').toISOString();

export interface GatesHeld {
  revision: number | null;
  profile: string;
  overrides: Readonly<Record<string, string | undefined>>;
  raised: unknown;
}

const overrideWords = (o: Readonly<Record<string, string | undefined>>): string =>
  Object.entries(o)
    .filter(([, m]) => m !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([g, m]) => `${g} ${m}`)
    .join(', ');

/** The gate profile and its per-gate overrides, as the project document holds them. */
export function gatesAgreement(
  projectId: string,
  held: GatesHeld,
  changes: readonly GateChangeView[],
): RepresentedAgreement {
  const forgeRule = 'Gates run under the standard profile, with no per-gate override.';
  const changed =
    held.profile !== 'standard' || Object.values(held.overrides).filter(Boolean).length > 0;
  const rule = `Gates run under the ${held.profile} profile${
    Object.values(held.overrides).filter(Boolean).length > 0
      ? `, with these gates overridden: ${overrideWords(held.overrides)}`
      : ', with no per-gate override'
  }${held.raised ? ', raised by Forge after an incident' : ''}.`;
  const latest = changes[0];
  return {
    view: {
      slug: GATE_PROFILE_SLUG,
      name: 'Gate profile',
      locked: false,
      authority: 'gates',
      door: `PUT /api/projects/${projectId}/gates`,
      state: changed ? 'overridden' : 'inherited',
      forge: {
        revision: 1,
        rule: forgeRule,
        detail: null,
        source: 'REQ-76: every project starts on the standard profile',
        restates: [{ kind: 'requirement', ref: 'REQ-76', title: 'Gate profiles and overrides' }],
        at: SEEDED_AT,
      },
      project: changed
        ? {
            revision: held.revision ?? 0,
            change: 'override',
            rule,
            detail: null,
            condition: null,
            reason: latest?.reason ?? 'set in the project document',
            actor: { id: latest?.actorUserId ?? null, name: latest?.actorName ?? null },
            at: latest?.at ?? SEEDED_AT,
            baseRevision: 1,
          }
        : null,
      effective: {
        rule: changed ? rule : forgeRule,
        detail: null,
        condition: null,
        from: changed ? 'config' : 'forge',
        revision: changed ? `config@${held.revision ?? 0}` : 'forge@1',
      },
      conflict: null,
    },
    history: changes.map(
      (c): AgreementRevisionView => ({
        layer: 'config',
        revision: c.configRevision,
        change: 'config',
        rule: `Gates run under the ${c.profileTo} profile${
          c.overridesTo && Object.keys(c.overridesTo as object).length > 0
            ? `, with these gates overridden: ${overrideWords(c.overridesTo as Record<string, string>)}`
            : ''
        }.`,
        detail: null,
        condition: null,
        reason: c.reason,
        actor: { id: c.actorUserId, name: c.actorName },
        at: c.at,
      }),
    ),
  };
}

export interface LanguageHeld {
  revision: number | null;
  contentLanguage: string;
  keepTermsInEnglish: string[];
}

/** The language a project's content is written in, as the project document holds it. */
export function languageAgreement(projectId: string, held: LanguageHeld): RepresentedAgreement {
  const forgeRule = 'Write content in English.';
  const changed = held.contentLanguage !== 'en' || held.keepTermsInEnglish.length > 0;
  const rule = `Write content in ${contentLanguageName(held.contentLanguage)}${
    held.keepTermsInEnglish.length > 0
      ? `, keeping ${held.keepTermsInEnglish.join(', ')} in English`
      : ''
  }.`;
  return {
    view: {
      slug: CONTENT_LANGUAGE_SLUG,
      name: 'Content language',
      locked: false,
      authority: 'content_language',
      door: `PUT /api/projects/${projectId}/config`,
      state: changed ? 'overridden' : 'inherited',
      forge: {
        revision: 1,
        rule: forgeRule,
        detail: null,
        source: 'REQ-13: a project with no setting writes English',
        restates: [{ kind: 'requirement', ref: 'REQ-13', title: 'Project content conventions' }],
        at: SEEDED_AT,
      },
      project: changed
        ? {
            revision: held.revision ?? 0,
            change: 'override',
            rule,
            detail: null,
            condition: null,
            reason: 'set in the project document',
            actor: { id: null, name: null },
            at: SEEDED_AT,
            baseRevision: 1,
          }
        : null,
      effective: {
        rule: changed ? rule : forgeRule,
        detail: null,
        condition: null,
        from: changed ? 'config' : 'forge',
        revision: changed ? `config@${held.revision ?? 0}` : 'forge@1',
      },
      conflict: null,
    },
    history: [],
  };
}

/** `@thanhnh agrees to recording work (a filing) on sid-desk`, or `any member of the room`. */
export function deciderWords(d: Pick<RulingDecider, 'member' | 'acts' | 'targets'>): string {
  const who = d.member === ANY_ROOM_MEMBER ? 'any member of the room' : `@${d.member}`;
  const acts = d.acts.map((a) => CHANNEL_DECIDER_ACT_LABEL[a] ?? a).join(', ');
  const where = d.targets?.length ? ` on ${d.targets.join(', ')}` : '';
  return `${who} agrees to ${acts}${where}`;
}

/**
 * Who agrees to which act, by target (BC-12), one agreement per ruling naming deciders: written in
 * that ruling, the one source the room's brief and its agree door both read (BC-11).
 */
export function rulingAgreements(
  projectId: string,
  deciders: readonly RulingDeciderRead[],
): RepresentedAgreement[] {
  const byRuling = new Map<string, RulingDeciderRead[]>();
  for (const d of deciders) byRuling.set(d.ruling, [...(byRuling.get(d.ruling) ?? []), d]);
  return [...byRuling.entries()].map(([ruling, named]) => {
    const first = named[0] as RulingDeciderRead;
    const rule = `${named.map(deciderWords).join('; ')}.`;
    const revision = Math.floor(first.updatedAt.getTime() / 1000);
    return {
      view: {
        slug: `${WHO_AGREES_PREFIX}${ruling}`,
        name: first.title,
        locked: false,
        authority: 'ruling',
        door: `PUT /api/projects/${projectId}/knowledge/${ruling}`,
        state: 'project_only',
        forge: null,
        project: {
          revision,
          change: 'addition',
          rule,
          detail: null,
          condition: null,
          reason: `the project's ruling knowledge:${ruling}`,
          actor: { id: null, name: null },
          at: first.updatedAt.toISOString(),
          baseRevision: null,
        },
        effective: {
          rule,
          detail: null,
          condition: null,
          from: 'config',
          revision: `config@${revision}`,
        },
        conflict: null,
      },
      history: [],
    };
  });
}
