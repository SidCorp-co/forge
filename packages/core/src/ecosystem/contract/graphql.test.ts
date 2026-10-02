import { describe, expect, it } from 'vitest';
import { exampleProblem, indexContract } from './elements.js';
import { diffGraphql } from './graphql-diff.js';
import { parseSdl } from './graphql-sdl.js';
import { type ImpactLink, linkImpact } from './impact.js';
import { ArtifactUnreadable, elementList, measureChange, parseArtifact } from './measure.js';

const SHOP = `
"""The storefront a workflow reads."""
schema { query: QueryRoot mutation: Mutation }

type QueryRoot {
  "Products, newest first."
  products(first: Int = 10, query: String): [Product!]!
  order(id: ID!): Order
}

type Mutation {
  productCreate(input: ProductInput!): Product
}

interface Node { id: ID! }

type Product implements Node @key(fields: "id") {
  id: ID!
  title: String!
  price: Float
  variants(first: Int): [Variant!]!
  status: ProductStatus!
}

type Variant implements Node {
  id: ID!
  sku: String
  price: Float!
}

type Order { id: ID! lines: [Variant!]! }

enum ProductStatus { ACTIVE DRAFT @deprecated(reason: "use ARCHIVED") ARCHIVED }

input ProductInput { title: String! price: Float = 0 }

extend type Product { vendor: String }
`;

const edit = (from: string, to: string) => {
  if (!SHOP.includes(from)) throw new Error(`fixture has no ${from}`);
  return SHOP.replace(from, to);
};

const diffOf = (next: string) => diffGraphql(parseSdl(SHOP), parseSdl(next));
const breaking = (next: string) =>
  diffOf(next)
    .filter((c) => c.level === 'breaking')
    .map((c) => c.element)
    .sort();

describe('a GraphQL contract is read from its SDL, strictly', () => {
  it('indexes each operation under its role, its arguments, and every type field', () => {
    const elements = elementList('graphql', parseArtifact('graphql', SHOP));
    expect(elements).toEqual(
      expect.arrayContaining([
        'Query.products',
        'Query.products(first)',
        'Query.order(id)',
        'Mutation.productCreate',
        'Mutation.productCreate(input)',
        'Product.title',
        'Product.vendor',
        'Product.variants(first)',
        'ProductStatus.DRAFT',
        'ProductInput.price',
      ]),
    );
    expect(elements).not.toContain('QueryRoot.products');
  });

  it.each([
    [
      'an operation document',
      'query { products { title } }',
      /operation document is not a contract/,
    ],
    [
      'an undefined type',
      'type Query { a: Missing }',
      /names type Missing, which the SDL never defines/,
    ],
    ['a field defined twice', 'type Query { a: Int a: String }', /Query\.a is defined twice/],
    ['no query root', 'type Thing { a: Int }', /defines no query root/],
    [
      'an unclosed block string',
      '"""never closed\ntype Query { a: Int }',
      /block string is never closed/,
    ],
    ['a stray character', 'type Query { a: Int; }', /";" is not a GraphQL character here/],
    [
      'an extension of nothing',
      'type Query { a: Int } extend type Gone { b: Int }',
      /extends a type the SDL never defines/,
    ],
    [
      'a variable as a default',
      'type Query { a(x: Int = $v): Int }',
      /variable belongs to an operation/,
    ],
  ])('refuses %s as ARTIFACT_UNREADABLE, naming where', (_what, sdl, why) => {
    expect(() => parseArtifact('graphql', sdl)).toThrow(ArtifactUnreadable);
    expect(() => parseArtifact('graphql', sdl)).toThrow(why);
  });

  it('a GraphQL example has no JSON schema to be checked against, so it is refused', () => {
    const index = indexContract('graphql', parseSdl(SHOP));
    expect(
      exampleProblem(index, { element: 'Query.products', direction: 'response', payload: {} }),
    ).toMatchObject({ code: 'EXAMPLE_NOT_IN_CONTRACT', detail: expect.stringMatching(/SDL/) });
  });
});

describe('the GraphQL differ classifies by what a caller can no longer do', () => {
  it('the same schema in another order measures nothing', async () => {
    const reordered = `${SHOP.split('extend type')[0]}\nextend type Product { vendor: String }`;
    expect(diffOf(reordered)).toEqual([]);
  });

  it('a removed operation, field, enum value and argument are breaking', () => {
    expect(breaking(edit('  order(id: ID!): Order\n', ''))).toContain('Query.order');
    expect(breaking(edit('  title: String!\n', ''))).toEqual(
      expect.arrayContaining([
        'Product.title',
        'Query.products.title',
        'Mutation.productCreate.title',
      ]),
    );
    expect(breaking(edit('DRAFT @deprecated(reason: "use ARCHIVED") ', ''))).toEqual(
      expect.arrayContaining(['ProductStatus.DRAFT', 'Query.products.status']),
    );
    expect(
      breaking(edit('products(first: Int = 10, query: String)', 'products(first: Int = 10)')),
    ).toEqual(['Query.products(query)']);
  });

  it('a new required argument breaks every caller; an optional one does not', () => {
    expect(breaking(edit('order(id: ID!)', 'order(id: ID!, shop: ID!)'))).toEqual([
      'Query.order(shop)',
    ]);
    expect(breaking(edit('order(id: ID!)', 'order(id: ID!, shop: ID)'))).toEqual([]);
    expect(breaking(edit('order(id: ID!)', 'order(id: ID!, shop: ID! = "a")'))).toEqual([]);
  });

  it('an output may grow stricter and an input looser; the other direction breaks', () => {
    expect(breaking(edit('  price: Float\n  variants', '  price: Float!\n  variants'))).toEqual([]);
    expect(breaking(edit('  title: String!\n', '  title: String\n'))).toEqual(
      expect.arrayContaining(['Product.title']),
    );
    expect(breaking(edit('order(id: ID!)', 'order(id: ID)'))).toEqual([]);
    expect(breaking(edit('variants(first: Int)', 'variants(first: Int!)'))).toEqual(
      expect.arrayContaining(['Product.variants(first)', 'Query.products.variants(first)']),
    );
  });

  it('an input type change binds the operation that takes it', () => {
    expect(
      breaking(
        edit(
          'input ProductInput { title: String! price: Float = 0 }',
          'input ProductInput { title: String! price: Float = 0 sku: String! }',
        ),
      ),
    ).toEqual(['Mutation.productCreate(input)', 'ProductInput.sku']);
  });

  it('an added enum value is a warning, so the version measures unknown, never non-breaking', async () => {
    const d = await measureChange('graphql', SHOP, edit('ARCHIVED }', 'ARCHIVED HIDDEN }'));
    expect(d).toMatchObject({
      tool: 'graphql-sdl-diff',
      toolVersion: 'forge-graphql-1',
      classification: 'unknown',
    });
  });

  it('a field reached through a union or an interface is named under each operation reaching it', () => {
    expect(breaking(edit('  sku: String\n', ''))).toEqual(
      expect.arrayContaining([
        'Variant.sku',
        'Query.products.variants.sku',
        'Query.order.lines.sku',
      ]),
    );
  });
});

describe("impact reads a link's GraphQL fields as operation.field paths", () => {
  const link = (over: Partial<ImpactLink>): ImpactLink => ({
    id: 'l1',
    consumer: 'autoflow',
    module: 'workflows/sync',
    pinnedVersion: '1.0.0',
    callSites: [{ path: 'src/sync.ts', line: 4, operation: 'query products' }],
    fieldsUsed: [],
    outsideContract: [],
    ...over,
  });
  const impactOf = async (next: string, l: ImpactLink) =>
    linkImpact('semver', '2.0.0', await measureChange('graphql', SHOP, next), l);

  it('breaks the link that reads the removed field, through the operation it calls', async () => {
    const out = await impactOf(
      edit('  sku: String\n', ''),
      link({ fieldsUsed: ['products.variants.sku'] }),
    );
    expect(out).toMatchObject({ verdict: 'breaks', reason: 'touched' });
    expect(out.breaks.map((b) => b.element)).toContain('Query.products.variants.sku');
    expect(out.breaks.flatMap((b) => b.fields)).toContain('variants.sku');
  });

  it('passes the link that calls the operation and reads other fields', async () => {
    const out = await impactOf(
      edit('  sku: String\n', ''),
      link({ fieldsUsed: ['Query.products.title'] }),
    );
    expect(out).toMatchObject({ verdict: 'passes', reason: 'no-breaking-change-touches' });
  });

  it('a path under another operation never matches', async () => {
    const out = await impactOf(
      edit('  sku: String\n', ''),
      link({
        callSites: [{ path: 'src/o.ts', line: 1, operation: 'Query.order' }],
        fieldsUsed: ['products.variants.sku'],
      }),
    );
    expect(out.breaks.map((b) => b.element)).toEqual(['Query.products.variants.sku']);
  });

  it('a removed operation breaks every caller of it whatever it reads', async () => {
    const out = await impactOf(
      edit('  order(id: ID!): Order\n', ''),
      link({
        callSites: [{ path: 'src/o.ts', line: 1, operation: 'order' }],
        fieldsUsed: ['order.id'],
      }),
    );
    expect(out).toMatchObject({ verdict: 'breaks' });
    expect(out.breaks.map((b) => b.element)).toContain('Query.order');
  });
});
