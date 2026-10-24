// @direct-test-of packages/core/src/guides/issue-guides.ts
// @direct-test-of packages/core/src/guides/issue-flow-guide.ts
// Every field a served guide tells a reader to send on `POST /api/issues/:id/transition` is one
// the route's own schema takes, the published contract takes exactly those keys, and every field a
// guide says the body refuses is one it does not:
// the lifecycle guide once said `note` counts as the reason, and the strict body refused it as an
// unknown key (ISS-566).

import { readFileSync } from 'node:fs';
import { ISSUE_TRANSITION_REFUSAL_CODES } from '@forge/contracts/issue-machine';
import { describe, expect, it } from 'vitest';
import { composeLayers } from '../assistant/prompt/layer.js';
import { METHOD_LAYERS } from '../assistant/prompt/layers.js';
import { provideAssistantMethod } from '../guides/assistant-method-guide.js';
import { getGuide, listGuides } from '../guides/registry.js';
import {
  refuseUnknownTransitionKeys,
  TRANSITION_BODY_FIELDS,
  transitionBodySchema,
} from './transition-body.js';

const ROUTE = '`POST /api/issues/:id/transition`';
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

interface Claim {
  guide: string;
  field: string;
  says: 'takes' | 'refuses';
  how: string;
}

/** The top-level keys of a body literal such as `{ toStatus: 'needs_info', reason, needs }`. */
function literalKeys(literal: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let part = '';
  for (const ch of `${literal},`) {
    if ('{[('.includes(ch)) depth += 1;
    if ('}])'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) {
      const key = /^\s*([A-Za-z_]\w*)\s*(?::|$)/.exec(part)?.[1];
      if (key) keys.push(key);
      part = '';
    } else part += ch;
  }
  return keys;
}

/** What one guide body says about the transition body's fields, in the three ways guides say it. */
function transitionClaims(guide: string, body: string): Claim[] {
  const claims: Claim[] = [];
  // `POST /api/issues/:id/transition` `{ toStatus, reason }` — the body written out
  for (const m of body.matchAll(new RegExp(`${esc(ROUTE)}\\s*\`\\{([^\`]*)\\}\``, 'g'))) {
    for (const field of literalKeys(m[1] ?? '')) {
      claims.push({ guide, field, says: 'takes', how: 'body literal' });
    }
  }
  // `reason` in the `POST /api/issues/:id/transition` body
  for (const m of body.matchAll(
    new RegExp(`\`([A-Za-z_]\\w*)(?::[^\`]*)?\` in the ${esc(ROUTE)} body`, 'g'),
  )) {
    claims.push({ guide, field: m[1] ?? '', says: 'takes', how: 'named in the body' });
  }
  // `note` is not a transition field
  for (const m of body.matchAll(/`([A-Za-z_]\w*)` is not a transition field/g)) {
    claims.push({ guide, field: m[1] ?? '', says: 'refuses', how: 'named as refused' });
  }
  return claims;
}

// what the composition root hands in at boot, so every guide is read as served
provideAssistantMethod(composeLayers(METHOD_LAYERS));

/** Field claims across every served guide. */
const claims = listGuides().flatMap(({ slug }) =>
  transitionClaims(slug, getGuide(slug)?.body ?? ''),
);

/** The rows of the lifecycle guide's needs_info field table: `| \`reason\` | why … | yes … |`. */
function parkTableFields(body: string): string[] {
  const at = body.indexOf('| Field | Says | Required |');
  if (at < 0) return [];
  const rows = body.slice(at).split('\n\n')[0]?.split('\n').slice(2) ?? [];
  return rows.map((row) => /^\| `([A-Za-z_]\w*)` \|/.exec(row)?.[1] ?? `<unreadable row: ${row}>`);
}

describe('the guides name only transition fields the route takes (ISS-566)', () => {
  it('reads the claims it checks, so a reworded guide cannot pass by matching nothing', () => {
    const lifecycle = claims.filter((c) => c.guide === 'pipeline-and-issue-lifecycle');
    expect(lifecycle).toContainEqual(
      expect.objectContaining({ field: 'reason', says: 'takes', how: 'named in the body' }),
    );
    expect(lifecycle).toContainEqual(expect.objectContaining({ field: 'note', says: 'refuses' }));
    expect(claims.filter((c) => c.how === 'body literal').length).toBeGreaterThan(0);
  });

  it('every field a guide says the body takes is a key of the schema the route validates with', () => {
    const unknown = claims
      .filter((c) => c.says === 'takes' && !TRANSITION_BODY_FIELDS.includes(c.field))
      .map((c) => `${c.guide}: \`${c.field}\` (${c.how})`);
    expect(unknown, `the transition body takes ${TRANSITION_BODY_FIELDS.join(', ')}`).toEqual([]);
  });

  it('every field a guide says the body refuses is one the schema does not take', () => {
    const taken = claims
      .filter((c) => c.says === 'refuses' && TRANSITION_BODY_FIELDS.includes(c.field))
      .map((c) => `${c.guide}: \`${c.field}\``);
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

describe('transitionClaims', () => {
  it('reads each of the three ways a guide names a field, and nothing else', () => {
    const body = [
      `${ROUTE} \`{ toStatus: 'needs_info', reason, about: { requirement: null } }\`.`,
      `Pass it as \`note\` in the ${ROUTE} body.`,
      `\`recovery: true\` in the ${ROUTE} body.`,
      '`comment` is not a transition field.',
      'The `reopen` status and `waitingKind` in prose name nothing.',
    ].join('\n');
    expect(transitionClaims('g', body).map((c) => `${c.says} ${c.field}`)).toEqual([
      'takes toStatus',
      'takes reason',
      'takes about',
      'takes note',
      'takes recovery',
      'refuses comment',
    ]);
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
    expect(refused?.refusals[0]?.detail).toContain(TRANSITION_BODY_FIELDS.toSorted().join(', '));
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
