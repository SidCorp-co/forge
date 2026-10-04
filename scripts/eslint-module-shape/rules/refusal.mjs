import { placeOf } from '../declaration.mjs';

const RULE_STATUSES = new Set([409, 412, 422, 423, 428]);
/** Codes the MCP door throws for what REST answers 400, 401, 404, 413, 500 or 503: transport, not rules. */
const TRANSPORT_CODES = new Set([
  'BAD_REQUEST',
  'NOT_FOUND',
  'UNAUTHORIZED',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL',
  'UNAVAILABLE',
]);
const CODE_TEXT = /^([A-Z][A-Z0-9_]{2,}):/;
const CODE_LIST = /(?:REFUSAL_CODES|RefusalCode|_CODES)$/;

function declaredIn(symbol, fragment) {
  return (symbol?.getDeclarations() ?? []).some((d) =>
    d.getSourceFile().fileName.includes(fragment),
  );
}

function isNamed(type, name, fragment) {
  const symbol = type?.getSymbol();
  return symbol?.getName() === name && declaredIn(symbol, fragment);
}

function extendsError(type, checker, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  const symbol = type.getSymbol();
  if (symbol?.getName() === 'Error' || symbol?.getName() === 'HTTPException') return true;
  const target = type.target ?? type;
  if (!target.isClassOrInterface?.()) return false;
  return (checker.getBaseTypes(target) ?? []).some((b) => extendsError(b, checker, seen));
}

function statusOf(node) {
  return node?.type === 'Literal' && typeof node.value === 'number' ? node.value : null;
}

function leadingText(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral') return node.quasis[0]?.value.cooked ?? '';
  return null;
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A rule refusal is the envelope packages/core/src/lib/refusal.ts builds, never an error class, an HTTPException, thrown text or a hand-built body (BC-16).',
    },
    schema: [],
    messages: {
      httpException:
        "throws HTTPException {{status}}, the error handler's shape; return the module's refusals, or throw its refuser's RefusalError",
      errorClass:
        'declares error class {{name}}; a rule refusal is the envelope, an invariant a plain Error',
      thrownCode:
        'throws the code {{code}} as text; return it as a refusal in the envelope (packages/core/src/lib/refusal.ts)',
      codeList: 'declares refusal codes {{name}} in core; codes are declared in packages/contracts',
      handBuilt:
        'answers {{status}} with a body of its own; a rule refusal is answered by refused() or problem() in packages/core/src/lib/refusal.ts',
    },
  },
  create(context) {
    const { kind } = placeOf(context.filename);
    const platform = kind === 'platform';
    const services = context.sourceCode.parserServices;
    const checker = services.program.getTypeChecker();
    const ruleStatus = (s) => RULE_STATUSES.has(s) || (s === 403 && !platform);
    const typeOf = (node) => services.getTypeAtLocation(node);

    function errorClass(node) {
      if (!node.superClass || platform || kind === 'adapter') return;
      if (!extendsError(typeOf(node), checker)) return;
      context.report({
        node: node.id ?? node,
        messageId: 'errorClass',
        data: { name: node.id?.name ?? '(anonymous)' },
      });
    }

    function codeList(node, id) {
      if (!platform && id?.type === 'Identifier' && CODE_LIST.test(id.name))
        context.report({ node, messageId: 'codeList', data: { name: id.name } });
    }

    return {
      NewExpression(node) {
        if (!isNamed(typeOf(node), 'HTTPException', '/hono/')) return;
        const status = statusOf(node.arguments[0]);
        if (ruleStatus(status))
          context.report({ node, messageId: 'httpException', data: { status } });
      },
      ClassDeclaration: errorClass,
      ClassExpression: errorClass,
      ThrowStatement(node) {
        const arg = node.argument;
        if (arg?.type !== 'NewExpression' && arg?.type !== 'CallExpression') return;
        if (arg.callee.type !== 'Identifier' || arg.callee.name !== 'Error') return;
        const code = CODE_TEXT.exec(leadingText(arg.arguments[0]) ?? '')?.[1];
        if (code && !TRANSPORT_CODES.has(code))
          context.report({ node, messageId: 'thrownCode', data: { code } });
      },
      ExportNamedDeclaration(node) {
        const d = node.declaration;
        if (d?.type === 'VariableDeclaration') for (const v of d.declarations) codeList(node, v.id);
        else if (d?.type === 'TSTypeAliasDeclaration') codeList(node, d.id);
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        if (callee.property.name !== 'json') return;
        const status = statusOf(node.arguments[1]);
        if (!ruleStatus(status)) return;
        if (!isNamed(typeOf(callee.object), 'Context', '/hono/')) return;
        context.report({ node, messageId: 'handBuilt', data: { status } });
      },
    };
  },
};
