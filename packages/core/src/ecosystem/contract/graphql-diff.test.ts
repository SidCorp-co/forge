// the differ runs on the one graphql-js copy only where vitest inlines graphql-inspector
// @direct-test-of packages/core/vitest.config.ts
import { describe, expect, it } from 'vitest';
import { classify } from './diff.js';
import { diffGraphql } from './graphql-diff.js';
import { parseSdl } from './graphql-sdl.js';

const BASE = `
enum State { DRAFT PUBLISHED }
union Result = Draft
type Draft { id: ID! }
interface Node { id: ID! }
type Workflow { id: ID! name: String! state: State! }
input Filter { name: String }
type Query { workflow(id: ID!, limit: Int = 10): Workflow, search(filter: Filter): [Result] }
type Mutation { save(id: ID!, definition: String!): Workflow }
`;

/** Each change measured from BASE to `next`, as `<check> <level>`. */
async function measured(next: string) {
  const changes = await diffGraphql(parseSdl(BASE), parseSdl(next));
  return { changes: changes.map((c) => `${c.check} ${c.level}`), class: classify(changes) };
}

describe('a GraphQL change graphql-inspector rates Dangerous', () => {
  it('an optional argument with no default added to an existing field is additive', async () => {
    const m = await measured(
      BASE.replace('definition: String!)', 'definition: String!, base_draft_version: Int)'),
    );
    expect(m).toEqual({ changes: ['graphql-field-argument-added info'], class: 'non-breaking' });
  });

  it.each([
    [
      'an argument added with a default',
      BASE.replace('definition: String!)', 'definition: String!, v: Int = 0)'),
      'graphql-field-argument-added',
    ],
    [
      'an enum value added to an existing enum',
      BASE.replace('DRAFT PUBLISHED', 'DRAFT PUBLISHED ARCHIVED'),
      'graphql-enum-value-added',
    ],
    [
      'a union member added to an existing union',
      `${BASE.replace('= Draft', '= Draft | Workflow')}`,
      'graphql-union-member-added',
    ],
    [
      'an interface added to an existing object type',
      BASE.replace('type Draft {', 'type Draft implements Node {'),
      'graphql-object-type-interface-added',
    ],
    [
      'an argument default changed',
      BASE.replace('limit: Int = 10', 'limit: Int = 20'),
      'graphql-field-argument-default-changed',
    ],
    [
      'an input field added with a default',
      BASE.replace(
        'input Filter { name: String }',
        'input Filter { name: String, archived: Boolean = false }',
      ),
      'graphql-input-field-added',
    ],
  ])('%s stays a warning, measured unknown', async (_, next, check) => {
    const m = await measured(next);
    expect(m.changes).toContain(`${check} warning`);
    expect(m.class).toBe('unknown');
  });

  it('a required argument added to an existing field is still breaking', async () => {
    const m = await measured(BASE.replace('definition: String!)', 'definition: String!, v: Int!)'));
    expect(m.changes).toContain('graphql-field-argument-added breaking');
    expect(m.class).toBe('breaking');
  });

  it('an additive argument beside a removed field measures breaking', async () => {
    const m = await measured(
      BASE.replace('definition: String!)', 'definition: String!, v: Int)').replace(
        ' name: String!',
        '',
      ),
    );
    expect(m.changes).toContain('graphql-field-argument-added info');
    expect(m.class).toBe('breaking');
  });
});
