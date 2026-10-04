import { isRouteFile } from '../../lib/module-shape.mjs';
import { placeOf } from '../declaration.mjs';
import { isDrizzleDb } from '../types.mjs';

const CALLS = new Set([
  'select',
  'selectDistinct',
  'selectDistinctOn',
  'insert',
  'update',
  'delete',
  'execute',
  'transaction',
  'query',
  'with',
  '$with',
  '$count',
  'refreshMaterializedView',
]);

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A route file validates, calls one service or read function, and answers; it holds no database call (BC-15).',
    },
    schema: [],
    messages: {
      query:
        "calls the database ({{call}}) in a route file; move it into the module's service or read function",
    },
  },
  create(context) {
    const { file } = placeOf(context.filename);
    if (!isRouteFile(file, context.sourceCode.text)) return {};
    const services = context.sourceCode.parserServices;
    const checker = services.program.getTypeChecker();
    return {
      MemberExpression(node) {
        if (node.computed || !CALLS.has(node.property.name)) return;
        if (!isDrizzleDb(services.getTypeAtLocation(node.object), checker)) return;
        context.report({ node, messageId: 'query', data: { call: node.property.name } });
      },
    };
  },
};
