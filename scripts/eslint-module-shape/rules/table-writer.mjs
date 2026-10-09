import { placeOf, shape } from '../declaration.mjs';
import { isDrizzleDb, tableNames } from '../types.mjs';

const WRITES = new Set(['insert', 'update', 'delete']);
const RAW_WRITE =
  /\b(?:INSERT\s+INTO|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|MERGE\s+INTO)\s+(?:ONLY\s+)?"?(\w+)"?|\bUPDATE\s+(?:ONLY\s+)?"?(\w+)"?\s+(?:(?:AS\s+)?\w+\s+)?SET\b/gi;

function isSqlTag(tag) {
  if (tag.type === 'Identifier') return tag.name === 'sql';
  return (
    tag.type === 'MemberExpression' && tag.object.type === 'Identifier' && tag.object.name === 'sql'
  );
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A table is written only by the module modules.json names as its owner (docs/patterns/core-module.md).',
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          generic: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['file', 'why'],
              properties: {
                file: { type: 'string', minLength: 1 },
                why: { type: 'string', minLength: 40 },
              },
            },
          },
        },
      },
    ],
    messages: {
      foreign:
        'writes {{table}} ({{sql}}), owned by {{owner}}; call a service of {{owner}} instead',
      unowned: 'writes {{table}} ({{sql}}), which no module in modules.json owns',
      undeclared: 'writes {{sql}}, which no schema file declares as a table',
      unnamed:
        "{{op}}s a table whose type does not carry its name, so its owner cannot be judged; pass the owner's concrete table",
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    const checker = services.program.getTypeChecker();
    const { owners, bySql, schemaFiles } = shape();
    const { file, module } = placeOf(context.filename);
    if (schemaFiles.has(file)) return {};
    const generic = (context.options[0]?.generic ?? []).some((g) => g.file === file);

    function judge(node, sql, op) {
      if (sql === null) {
        if (generic) return;
        context.report({ node, messageId: 'unnamed', data: { op } });
        return;
      }
      const table = bySql.get(sql);
      if (!table) {
        context.report({ node, messageId: 'undeclared', data: { sql } });
        return;
      }
      const owner = owners.get(table);
      if (owner === module) return;
      context.report({
        node,
        messageId: owner ? 'foreign' : 'unowned',
        data: { table, sql, owner },
      });
    }

    function rawSql(node, quasis, expressions) {
      let text = '';
      for (const [i, q] of quasis.entries()) {
        text += q;
        const e = expressions[i];
        if (!e) continue;
        const [name] = tableNames(services.getTypeAtLocation(e), checker);
        text += name === undefined ? ' __expr__ ' : name === null ? ' __table__ ' : `"${name}"`;
      }
      for (const m of text.matchAll(RAW_WRITE)) {
        const name = m[1] ?? m[2];
        if (name === '__table__') judge(node, null, 'write');
        else if (bySql.has(name)) judge(node, name, 'write');
      }
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        const op = callee.property.name;
        if (op === 'raw' && isSqlTag(callee)) {
          const arg = node.arguments[0];
          if (arg?.type === 'Literal' && typeof arg.value === 'string')
            rawSql(node, [arg.value], []);
          return;
        }
        if (!WRITES.has(op) || !node.arguments[0]) return;
        if (!isDrizzleDb(services.getTypeAtLocation(callee.object), checker)) return;
        for (const sql of tableNames(services.getTypeAtLocation(node.arguments[0]), checker))
          judge(node, sql, op);
      },
      TaggedTemplateExpression(node) {
        if (!isSqlTag(node.tag)) return;
        rawSql(
          node,
          node.quasi.quasis.map((q) => q.value.cooked ?? q.value.raw),
          node.quasi.expressions,
        );
      },
    };
  },
};
