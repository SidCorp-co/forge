// @direct-test-of packages/core/src/guides/issue-guides.ts
// @direct-test-of packages/core/src/guides/issue-flow-guide.ts
// @direct-test-of packages/core/src/guides/workflow-design-guide.ts
// @direct-test-of packages/core/src/prompt/facts/drive-rules.ts
// @direct-test-of packages/core/src/prompt/facts/registry.ts
// Every field a served guide or run prompt names in a sentence about
// `POST /api/issues/:id/transition`, in any phrasing, is one the route's own schema declares; the
// published contract takes exactly those keys; and the one way a text may name a field the body
// lacks is as refused. The lifecycle guide once said `note` counts as the reason, and the strict
// body refused it as an unknown key (ISS-566).

import { readFileSync } from 'node:fs';
import { ISSUE_TRANSITION_REFUSAL_CODES } from '@forge/contracts/issue-machine';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { composeLayers } from '../assistant/prompt/layer.js';
import { METHOD_LAYERS } from '../assistant/prompt/layers.js';
import { provideAssistantMethod } from '../guides/assistant-method-guide.js';
import { getGuide, listGuides } from '../guides/registry.js';
import {
  DRIVE_RULES_TEXT,
  DRIVE_TOOL_REFERENCE_TEXT,
  STEP_TOOL_REFERENCE_TEXT,
} from '../prompt/facts/drive-rules.js';
import { FORGE_FACTS, OPERATING_AFFORDANCES_TEXT } from '../prompt/facts/registry.js';
import {
  refuseUnknownTransitionKeys,
  TRANSITION_BODY_FIELDS,
  transitionBodySchema,
} from './transition-body.js';

const ROUTE = '`POST /api/issues/:id/transition`';

interface OpenApi {
  paths: Record<
    string,
    {
      post?: {
        requestBody?: {
          content?: Record<
            string,
            { schema?: { properties?: Record<string, unknown>; additionalProperties?: unknown } }
          >;
        };
      };
    }
  >;
}

/** What the transition body can hold, read off its schema: every key at any depth, and every value it fixes. */
interface Vocabulary {
  fields: ReadonlySet<string>;
  values: ReadonlySet<string>;
}

function vocabularyOf(schema: z.ZodType): Vocabulary {
  const fields = new Set<string>();
  const values = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (n.properties !== null && typeof n.properties === 'object') {
      for (const key of Object.keys(n.properties)) fields.add(key);
    }
    if (Array.isArray(n.enum)) for (const v of n.enum) values.add(String(v));
    if ('const' in n) values.add(String(n.const));
    if (n.type === 'null') values.add('null');
    for (const child of Object.values(n)) walk(child);
  };
  walk(z.toJSONSchema(schema, { unrepresentable: 'any' }));
  return { fields, values };
}

const BODY = vocabularyOf(transitionBodySchema);

/** One clause of a guide: paragraphs, list items and table rows apart, then split at its stops, semicolons and ` · ` runs. */
function sentencesOf(body: string): string[] {
  return body
    .split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.|\|)\s)/)
    .flatMap((block) =>
      block.replace(/\s*\n\s*/g, ' ').split(/(?<=[.!?:])\s+(?=[A-Z`(*])|(?<=;)\s+|\s+·\s+/),
    )
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const ROUTE_NAMED = /\bissues\/(?::id|\{id\}|<id>|<uuid>)\/transition\b/;
const TRANSITION_WORD = /\btransitions?\b/;
const TRANSITION_PART = /\btransition (?:body|fields?|keys?|request)\b/;
const SENT_WORD = /\b(?:reason|body|send|sends|sent|carr(?:y|ies)|takes?|counts?)\b/i;

/**
 * A sentence is about the transition request when it names its route, or speaks of the transition
 * (the lowercase word, outside code) together with what a request sends. The scope is the phrase's
 * subject, never its wording, so a field it names is checked however the sentence puts it.
 */
function isAboutTheTransitionRequest(sentence: string): boolean {
  if (ROUTE_NAMED.test(sentence)) return true;
  const prose = sentence.replace(/`[^`]*`/g, ' ');
  return TRANSITION_PART.test(prose) || (TRANSITION_WORD.test(prose) && SENT_WORD.test(prose));
}

/** The one phrasing that may name a key the body lacks: naming it as refused. */
const NAMED_AS_REFUSED = /`([A-Za-z_]\w*)` is not a transition field/g;

/** Every key a code span names: a body literal's keys at any depth, a `key: value`, a dotted path, a bare word. */
function namesIn(span: string): Array<{ name: string; as: 'key' | 'word' }> {
  // a command or route written out: only the body it sends to the transition names keys
  if (span.includes('/')) {
    const sent = ROUTE_NAMED.test(span) ? /\{.*\}/.exec(span)?.[0] : undefined;
    return sent ? namesIn(sent) : [];
  }
  if (!/^[{[a-z]/.test(span)) return [];
  if (/^[{[]/.test(span)) {
    return span
      .replace(/"([A-Za-z_]\w*)"\s*:/g, '$1:')
      .replace(/'[^']*'|"[^"]*"/g, "''")
      .split(/[{}[\],]/)
      .map((part) => /^\s*([A-Za-z_]\w*)\s*(?::|\??$)/.exec(part)?.[1])
      .filter((name): name is string => name !== undefined)
      .map((name) => ({ name, as: 'key' as const }));
  }
  const keyed = /^([a-z]\w*)\s*[:=]/.exec(span);
  if (keyed?.[1]) return [{ name: keyed[1], as: 'key' }];
  if (/^[a-z]\w*(?:\.[A-Za-z_]\w*)+$/.test(span)) {
    return span.split('.').map((name) => ({ name, as: 'key' as const }));
  }
  if (/^[a-z]\w*$/.test(span)) return [{ name: span, as: 'word' }];
  return [];
}

interface Finding {
  guide: string;
  name: string;
  as: 'key' | 'word';
  sentence: string;
  refused: boolean;
}

/** Each name a guide's transition sentences carry in code, and whether the sentence names it as refused. */
function transitionNames(guide: string, body: string): Finding[] {
  return sentencesOf(body)
    .filter(isAboutTheTransitionRequest)
    .flatMap((sentence) => {
      const refused = new Set([...sentence.matchAll(NAMED_AS_REFUSED)].map((m) => m[1] ?? ''));
      return [...sentence.matchAll(/`([^`]+)`/g)].flatMap((m) =>
        namesIn(m[1] ?? '').map(({ name, as }) => ({
          guide,
          name,
          sentence,
          refused: refused.has(name),
          as,
        })),
      );
    });
}

/** A name the body lacks: a key that is no field, a bare word that is neither a field nor a value. */
function lacked(f: Finding): boolean {
  if (BODY.fields.has(f.name)) return false;
  return f.as === 'key' || !BODY.values.has(f.name);
}

// what the composition root hands in at boot, so every guide is read as served
provideAssistantMethod(composeLayers(METHOD_LAYERS));

/** Every text served to a reader that may teach the move: each guide, and each prompt text a run is handed. */
const SERVED: ReadonlyArray<readonly [string, string]> = [
  ...listGuides().map(({ slug }) => [slug, getGuide(slug)?.body ?? ''] as const),
  ...FORGE_FACTS.map((f) => [`fact ${f.id}`, f.render()] as const),
  ['drive rules', DRIVE_RULES_TEXT],
  ['drive tool reference', DRIVE_TOOL_REFERENCE_TEXT],
  ['step tool reference', STEP_TOOL_REFERENCE_TEXT],
  ['operating affordances', OPERATING_AFFORDANCES_TEXT],
];

const findings = SERVED.flatMap(([source, text]) => transitionNames(source, text));

/** The rows of the lifecycle guide's needs_info field table: `| \`reason\` | why … | yes … |`. */
function parkTableFields(body: string): string[] {
  const at = body.indexOf('| Field | Says | Required |');
  if (at < 0) return [];
  const rows = body.slice(at).split('\n\n')[0]?.split('\n').slice(2) ?? [];
  return rows.map((row) => /^\| `([A-Za-z_]\w*)` \|/.exec(row)?.[1] ?? `<unreadable row: ${row}>`);
}

describe('the guides name only transition fields the route takes (ISS-566)', () => {
  it('reads the sentences it checks in every guide that teaches the move, so a reworded guide cannot pass by matching nothing', () => {
    const guides = new Set(findings.map((f) => f.guide));
    for (const guide of [
      'pipeline-and-issue-lifecycle',
      'issue-flow',
      'workflow-design',
      'drive tool reference',
    ]) {
      expect(guides, guide).toContain(guide);
    }
    expect(findings).toContainEqual(
      expect.objectContaining({ guide: 'pipeline-and-issue-lifecycle', name: 'reason' }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        guide: 'pipeline-and-issue-lifecycle',
        name: 'note',
        refused: true,
      }),
    );
  });

  it('every field a guide names beside the transition is a key of the schema the route validates with, unless named as refused', () => {
    const unknown = findings
      .filter((f) => !f.refused && lacked(f))
      .map((f) => `${f.guide}: \`${f.name}\` in "${f.sentence}"`);
    expect(unknown, `the transition body takes ${TRANSITION_BODY_FIELDS.join(', ')}`).toEqual([]);
  });

  it('every field a guide names as refused is one the schema does not take', () => {
    const taken = findings
      .filter((f) => f.refused && BODY.fields.has(f.name))
      .map((f) => `${f.guide}: \`${f.name}\``);
    expect(taken).toEqual([]);
  });

  it('the published contract takes exactly the keys the route validates, and no other', () => {
    const contract = JSON.parse(
      readFileSync(new URL('../../contracts/forge-api.openapi.json', import.meta.url), 'utf8'),
    ) as OpenApi;
    const body =
      contract.paths['/api/issues/{id}/transition']?.post?.requestBody?.content?.[
        'application/json'
      ]?.schema;
    expect(Object.keys(body?.properties ?? {}).sort()).toEqual([...TRANSITION_BODY_FIELDS].sort());
    expect(body?.additionalProperties).toBe(false);
  });

  it("the lifecycle guide's park field table lists only transition fields", () => {
    const fields = parkTableFields(getGuide('pipeline-and-issue-lifecycle')?.body ?? '');
    expect(fields).toContain('reason');
    expect(fields.filter((f) => !TRANSITION_BODY_FIELDS.includes(f))).toEqual([]);
  });
});

describe('transitionNames', () => {
  const lackedIn = (body: string) =>
    transitionNames('g', body)
      .filter((f) => !f.refused && lacked(f))
      .map((f) => f.name);

  it('finds a lacked field in any phrasing of a sentence about the transition request', () => {
    expect(lackedIn(`Pass it in the ${ROUTE} body (\`note\` also counts).`)).toEqual(['note']);
    expect(
      lackedIn('A park sent on the transition carries its reason in `note` as well as `reason`.'),
    ).toEqual(['note']);
    expect(lackedIn(`${ROUTE} \`{ toStatus: 'on_hold', note, awaitsMerge: { id } }\`.`)).toEqual([
      'note',
      'id',
    ]);
    expect(lackedIn(`Send \`comment: 'why'\` on ${ROUTE}.`)).toEqual(['comment']);
    expect(lackedIn('`note` is a transition field too.')).toEqual(['note']);
    expect(lackedIn(`${ROUTE} reads \`awaitsMerge.issueNumber\`.`)).toEqual(['issueNumber']);
    expect(
      lackedIn(
        `Move it: \`issues/<id>/transition -X POST -d '{"toStatus":"on_hold","note":"x"}'\`.`,
      ),
    ).toEqual(['note']);
  });

  it('passes the fields and values the schema declares, codes, routes and a field named as refused', () => {
    expect(
      lackedIn(
        `${ROUTE} \`{ toStatus: 'needs_info', reason, about: { requirement: null }, awaitsDesign: { workflowId, revision } }\` with \`recovery: true\`, \`waitingKind\` \`needs_decision\`, refused \`TRANSITION_FIELD_UNKNOWN\`.`,
      ),
    ).toEqual([]);
    expect(lackedIn('`reason` is the only field: `note` is not a transition field.')).toEqual([]);
  });

  it('reads no sentence that is not about the transition request', () => {
    expect(lackedIn('A decline carries its reason in `note`.')).toEqual([]);
    expect(lackedIn('No transition writes `merged_at`, an evidence field.')).toEqual([]);
    expect(lackedIn('The `ILLEGAL_TRANSITION` refusal names `note`.')).toEqual([]);
  });
});

describe('refuseUnknownTransitionKeys', () => {
  const refusalOf = (body: unknown) => {
    const parsed = transitionBodySchema.safeParse(body);
    try {
      refuseUnknownTransitionKeys(parsed.error?.issues ?? []);
    } catch (err) {
      return err as { refusals: Array<{ code: string; path: string; detail: string }> };
    }
    return null;
  };

  it('refuses `note` at its own path, naming the keys the body takes and where a reason goes', () => {
    const refused = refusalOf({ toStatus: 'on_hold', note: 'paused', waitingKind: 'nope' });
    expect(refused?.refusals.map((r) => `${r.code} ${r.path}`)).toEqual([
      'TRANSITION_FIELD_UNKNOWN /note',
      'BAD_REQUEST /waitingKind',
    ]);
    expect(refused?.refusals[0]?.detail).toContain([...TRANSITION_BODY_FIELDS].sort().join(', '));
    expect(refused?.refusals[0]?.detail).toContain("a move's reason goes in `reason`");
  });

  it('answers with the code the lifecycle guide names for a field the body does not take', () => {
    const guide = getGuide('pipeline-and-issue-lifecycle')?.body ?? '';
    const taught = /the body does not take it is refused `([A-Z_]+)`/.exec(guide)?.[1];
    expect(ISSUE_TRANSITION_REFUSAL_CODES).toContain(taught);
    expect(refusalOf({ toStatus: 'on_hold', note: 'paused' })?.refusals[0]?.code).toBe(taught);
  });

  it('leaves a body with no unknown key to the shared answer', () => {
    expect(refusalOf({ toStatus: 'on_hold', reason: '' })).toBeNull();
    expect(refusalOf({ toStatus: 'on_hold', reason: 'paused' })).toBeNull();
  });
});
