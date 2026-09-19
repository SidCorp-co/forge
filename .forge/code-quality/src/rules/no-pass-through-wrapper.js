import { matchesFile } from "../design/tokens.js";
import { PASS_THROUGH_WAIVER } from "../line-metrics.js";

/**
 * A layer that forwards and adds nothing is a name for something that already has
 * one. It costs a file to open, an import to follow and a stack frame to read past,
 * and it hides the thing it wraps from every search for the real caller.
 *
 * The reason is mandatory, as with every waiver here: a bare marker fails.
 */
const WAIVER = PASS_THROUGH_WAIVER;

/** Elements that carry no semantics of their own, so an empty one carries nothing. */
export const DEFAULT_NEUTRAL_ELEMENTS = ["div", "span"];

/** Erased at runtime, so they hide nothing a caller would have to repeat. */
const TYPE_ONLY = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);

function withoutTypes(node) {
  let current = node;
  while (current && TYPE_ONLY.has(current.type)) current = current.expression;
  return current;
}

/**
 * The exact expression a caller writes instead, or null when there is none — the
 * report quotes this, so a remedy is never unfollowable. Only a path that RUNS
 * nothing qualifies: a receiver built by a call or a `new` is work the wrapper
 * does for every caller, and `z.string().trim().max(n)` has no name to offer, so
 * naming the bare property asked for `max` — the wrapper's own parameter.
 */
function staticPath(node) {
  const target = withoutTypes(node);
  if (!target) return null;
  if (target.type === "Identifier") return target.name;
  if (target.type === "ThisExpression") return "this";
  if (target.type === "Literal") return target.raw;
  if (target.type !== "MemberExpression") return null;
  const object = staticPath(target.object);
  if (object === null) return null;
  if (!target.computed) {
    return target.property.type === "Identifier" ? `${object}.${target.property.name}` : null;
  }
  const key = staticPath(target.property);
  return key === null ? null : `${object}[${key}]`;
}

/** The single expression a body returns, or null when it does more than return one. */
function returnedExpression(node) {
  if (node.body.type !== "BlockStatement") return node.body;
  const [only] = node.body.body;
  if (node.body.body.length !== 1 || only?.type !== "ReturnStatement") return null;
  return only.argument ?? null;
}

/**
 * True when the call passes the function's own parameters straight through: same
 * identifiers, same order, nothing added, nothing dropped. A default, a
 * destructuring pattern or a reordered argument all make the wrapper do something.
 */
function forwardsParameters(params, args) {
  // A thunk takes nothing and defers a call. `() => budget.abort()` is not the
  // same value as `budget.abort`, which loses the receiver, so it forwards nothing.
  if (params.length === 0) return false;
  if (params.length !== args.length) return false;
  return params.every((param, index) => {
    const argument = args[index];
    if (param.type === "Identifier") {
      return argument.type === "Identifier" && argument.name === param.name;
    }
    if (param.type === "RestElement" && param.argument.type === "Identifier") {
      return (
        argument.type === "SpreadElement" &&
        argument.argument.type === "Identifier" &&
        argument.argument.name === param.argument.name
      );
    }
    return false;
  });
}

/**
 * The name a caller reaches this function by, or null when it has none. An
 * anonymous callback is not a layer: `roots.map((root) => path.resolve(root))`
 * cannot be shortened to the callee itself, which would receive `map`'s index as
 * a second argument. Only something a caller must route *through* is a wrapper.
 */
function nameOf(node) {
  if (node.id?.name) return node.id.name;
  const parent = node.parent;
  if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name;
  if (parent?.type === "Property" && parent.key.type === "Identifier") return parent.key.name;
  if (parent?.type === "MethodDefinition" && parent.key.type === "Identifier") return parent.key.name;
  return null;
}

/** Children that are not whitespace between tags, and not a `{/* … *​/}` comment. */
function realChildren(node) {
  return node.children.filter((child) => {
    if (child.type === "JSXText") return child.value.trim().length > 0;
    return child.type !== "JSXExpressionContainer" || child.expression.type !== "JSXEmptyExpression";
  });
}

/** The nodes a waiver comment may sit before: the whole declaration, not the value. */
const DECLARATION_CHAIN = new Set([
  "ExportDefaultDeclaration",
  "ExportNamedDeclaration",
  "ExpressionStatement",
  "MethodDefinition",
  "Property",
  "PropertyDefinition",
  "VariableDeclaration",
  "VariableDeclarator",
]);

function elementName(node) {
  const name = node.openingElement.name;
  return name.type === "JSXIdentifier" ? name.name : null;
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description: "Reject a layer that forwards to another and adds nothing",
      recommended: true,
    },
    schema: [
      {
        type: "object",
        properties: {
          functions: { type: "boolean" },
          components: { type: "boolean" },
          elements: { type: "boolean" },
          neutralElements: { type: "array", items: { type: "string" } },
          exemptFiles: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      passThroughFunction:
        "{{name}} only forwards to {{target}}. Call {{target}} directly and delete the wrapper.",
      passThroughComponent:
        "{{name}} only renders <{{target}}> with its own props. Use {{target}} directly and " +
        "delete the wrapper.",
      emptyWrapper:
        "<{{tag}}> wraps a single child and carries nothing of its own. Delete it and keep the child.",
    },
  },
  create(context) {
    const {
      functions = true,
      components = true,
      elements = true,
      neutralElements = DEFAULT_NEUTRAL_ELEMENTS,
      exemptFiles = [],
    } = context.options[0] ?? {};

    if (matchesFile(context.filename, exemptFiles)) return {};

    const { sourceCode } = context;
    const neutral = new Set(neutralElements);

    function waived(node) {
      const marks = (comment) => WAIVER.test(comment.value);
      if (sourceCode.getCommentsInside(node).some(marks)) return true;
      for (let current = node; current; current = current.parent) {
        if (sourceCode.getCommentsBefore(current).some(marks)) return true;
        if (!DECLARATION_CHAIN.has(current.parent?.type)) return false;
      }
      return false;
    }

    function checkFunction(node) {
      const name = nameOf(node);
      if (name === null) return;
      const returned = returnedExpression(node);
      if (returned === null) return;

      // A component is judged on what it renders, a function on what it calls.
      if (returned.type === "JSXElement") {
        if (!components) return;
        const target = elementName(returned);
        const [attribute] = returned.openingElement.attributes;
        const [param] = node.params;
        const spreadsOnly =
          returned.openingElement.attributes.length === 1 &&
          attribute?.type === "JSXSpreadAttribute" &&
          attribute.argument.type === "Identifier" &&
          param?.type === "Identifier" &&
          attribute.argument.name === param.name;
        if (!target || !spreadsOnly || realChildren(returned).length > 0) return;
        if (waived(node)) return;
        context.report({
          node,
          messageId: "passThroughComponent",
          data: { name, target },
        });
        return;
      }

      if (!functions) return;
      // A type predicate IS the work: `scope is Scope` narrows where the bare call cannot.
      if (node.returnType?.typeAnnotation?.type === "TSTypePredicate") return;
      // `return await f(x)` forwards exactly as `return f(x)` does.
      const call = returned.type === "AwaitExpression" ? returned.argument : returned;
      if (call?.type !== "CallExpression" || call.optional) return;
      const target = staticPath(call.callee);
      if (target === null || !forwardsParameters(node.params, call.arguments)) return;
      if (waived(node)) return;
      context.report({
        node,
        messageId: "passThroughFunction",
        data: { name, target },
      });
    }

    return {
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
      JSXElement(node) {
        if (!elements) return;
        const tag = elementName(node);
        if (tag === null || !neutral.has(tag)) return;
        if (node.openingElement.attributes.length > 0) return;
        const children = realChildren(node);
        if (children.length !== 1 || children[0].type !== "JSXElement") return;
        if (waived(node)) return;
        context.report({ node: node.openingElement, messageId: "emptyWrapper", data: { tag } });
      },
    };
  },
};
