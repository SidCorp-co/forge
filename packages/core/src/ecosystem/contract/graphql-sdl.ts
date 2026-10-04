/** Reads a GraphQL contract with graphql-js; every way an SDL can fail to build is refused as `ARTIFACT_UNREADABLE`, naming where. */

import {
  buildASTSchema,
  type DocumentNode,
  GraphQLError,
  type GraphQLField,
  type GraphQLSchema,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isTypeSystemDefinitionNode,
  isTypeSystemExtensionNode,
  Kind,
  parse,
  validateSchema,
  visit,
} from 'graphql';
import { refuseEcosystem } from '../refusals.js';

export type SdlSchema = GraphQLSchema;

type RootRole = 'query' | 'mutation' | 'subscription';

const ROOT_NAME: Record<RootRole, string> = {
  query: 'Query',
  mutation: 'Mutation',
  subscription: 'Subscription',
};

const sdlUnreadable = (why: string) =>
  refuseEcosystem('ARTIFACT_UNREADABLE', `a graphql artifact is SDL text, and ${why}`, '/artifact');

function unreadable(err: unknown) {
  if (err instanceof GraphQLError) {
    const at = err.locations?.[0];
    return sdlUnreadable(
      at ? `the SDL does not parse at ${at.line}:${at.column}: ${err.message}` : err.message,
    );
  }
  return sdlUnreadable(err instanceof Error ? err.message : String(err));
}

/** Renames each root to its role's canonical name, so `QueryRoot.products` and `Query.products` are one operation; a canonical name another type already holds is left alone. */
function canonicalRoots(doc: DocumentNode): DocumentNode {
  const defined = new Set<string>();
  const renames = new Map<string, string>();
  for (const def of doc.definitions) {
    if ('name' in def && def.name && def.kind !== Kind.DIRECTIVE_DEFINITION)
      defined.add(def.name.value);
    if (def.kind !== Kind.SCHEMA_DEFINITION && def.kind !== Kind.SCHEMA_EXTENSION) continue;
    for (const op of def.operationTypes ?? []) {
      const canonical = ROOT_NAME[op.operation as RootRole];
      if (op.type.name.value !== canonical) renames.set(op.type.name.value, canonical);
    }
  }
  for (const [from, to] of renames) if (defined.has(to)) renames.delete(from);
  if (renames.size === 0) return doc;
  const renamed = <T extends { name: { value: string } }>(node: T): T | undefined => {
    const to = renames.get(node.name.value);
    return to ? { ...node, name: { ...node.name, value: to } } : undefined;
  };
  return visit(doc, {
    NamedType: renamed,
    ObjectTypeDefinition: renamed,
    ObjectTypeExtension: renamed,
  });
}

export function parseSdl(text: string): SdlSchema {
  let doc: DocumentNode;
  try {
    doc = parse(text);
  } catch (err) {
    throw unreadable(err);
  }
  for (const def of doc.definitions) {
    if (isTypeSystemDefinitionNode(def) || isTypeSystemExtensionNode(def)) continue;
    const at = def.loc ? `at ${def.loc.startToken.line}:${def.loc.startToken.column} ` : '';
    throw sdlUnreadable(
      `the SDL holds an operation ${at}— an SDL holds type-system definitions, and an operation document is not a contract`,
    );
  }
  let schema: GraphQLSchema;
  try {
    schema = buildASTSchema(canonicalRoots(doc));
  } catch (err) {
    throw unreadable(err);
  }
  const [invalid] = validateSchema(schema);
  if (invalid) throw unreadable(invalid);
  if (!schema.getQueryType())
    throw sdlUnreadable('the SDL defines no query root (a type Query, or schema { query: … })');
  return schema;
}

export type SdlField = GraphQLField<unknown, unknown>;

/** Each root field under its role's canonical name. */
export function operationsOf(schema: SdlSchema): { element: string; field: SdlField }[] {
  const roots = [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()];
  return roots.flatMap((root) =>
    root
      ? Object.values(root.getFields()).map((field) => ({
          element: `${root.name}.${field.name}`,
          field,
        }))
      : [],
  );
}

const isRootType = (schema: SdlSchema, name: string): boolean =>
  [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()].some(
    (t) => t?.name === name,
  );

export function sdlElements(schema: SdlSchema): string[] {
  const out = new Set<string>();
  for (const { element, field } of operationsOf(schema)) {
    out.add(element);
    for (const a of field.args) out.add(`${element}(${a.name})`);
  }
  for (const t of Object.values(schema.getTypeMap())) {
    if (t.name.startsWith('__') || isRootType(schema, t.name)) continue;
    if (isEnumType(t)) {
      for (const v of t.getValues()) out.add(`${t.name}.${v.name}`);
    } else if (isInputObjectType(t)) {
      for (const f of Object.values(t.getFields())) out.add(`${t.name}.${f.name}`);
    } else if (isObjectType(t) || isInterfaceType(t)) {
      for (const f of Object.values(t.getFields())) {
        out.add(`${t.name}.${f.name}`);
        for (const a of f.args) out.add(`${t.name}.${f.name}(${a.name})`);
      }
    }
  }
  return [...out];
}
