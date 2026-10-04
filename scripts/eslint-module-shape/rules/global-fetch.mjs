import { placeOf } from '../declaration.mjs';

const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self', 'global']);

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Every external system is reached through one adapter port; only an adapter module reaches the global fetch (ADR 0006).',
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          allow: {
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
      fetch:
        "reaches the global fetch outside an adapter; call the port's typed function under packages/core/src/integrations/, or add a port",
    },
  },
  create(context) {
    const { file, kind } = placeOf(context.filename);
    const allowed = (context.options[0]?.allow ?? []).some((a) => a.file === file);
    if (kind === 'adapter' || allowed) return {};
    const report = (node) => context.report({ node, messageId: 'fetch' });
    return {
      'Program:exit'(program) {
        const globalScope = context.sourceCode.getScope(program);
        const declared = globalScope.set.get('fetch');
        const refs = declared && declared.defs.length === 0 ? declared.references : [];
        const through = globalScope.through.filter((r) => r.identifier.name === 'fetch');
        for (const ref of [...refs, ...through])
          if (ref.identifier.parent?.type !== 'TSTypeQuery') report(ref.identifier);
      },
      MemberExpression(node) {
        if (node.computed || node.property.name !== 'fetch') return;
        if (node.object.type === 'Identifier' && GLOBAL_OBJECTS.has(node.object.name)) report(node);
      },
    };
  },
};
