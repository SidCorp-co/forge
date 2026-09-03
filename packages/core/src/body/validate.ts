/**
 * Sanitize, then validate — two rules with two different outcomes, and mixing
 * them up is the failure this module exists to avoid.
 *
 * **Plain markup is repaired and reported.** An unknown tag is unwrapped, a
 * disallowed attribute dropped, a `<script>` removed whole, each one named in
 * `warnings[]`. It is never a refusal, because Decision 3 makes prose always
 * valid — a human who types a `<div>` must not be told no.
 *
 * **`forge-*` markup is refused and named.** An unregistered component, an
 * attribute outside its schema, a missing or out-of-order slot: 400, with the
 * element, the attribute and its legal set in the message. That asymmetry is
 * the whole design — the gate binds the format agents write, and leaves the
 * prose humans write alone.
 */

import type { z } from 'zod';
import {
  type ComponentSpec,
  type ComponentView,
  isComponentName,
  ROOT_COMPONENT_NAMES,
  specFor,
} from './components.js';
import { BodyInvalidError } from './errors.js';
import type { BodyNode } from './parse.js';
import { DROPPED_ELEMENTS, PLAIN_TAGS, plainAttrAllowed, urlAllowed } from './plain-tags.js';

export interface ValidatedBody {
  nodes: BodyNode[];
  warnings: string[];
  /** The single root component's name, or null when the body is plain prose. */
  template: string | null;
  slots: Record<string, unknown> | null;
}

const URL_ATTRS = new Set(['href', 'src']);

class Sink {
  readonly warnings: string[] = [];
  private readonly seen = new Set<string>();

  warn(message: string): void {
    if (this.seen.has(message)) return;
    this.seen.add(message);
    this.warnings.push(message);
  }
}

function legalValues(schema: z.ZodType, attr: string): string {
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  const field = shape?.[attr] as { options?: readonly string[] } | undefined;
  const options = field?.options;
  return options ? ` — legal values: ${options.join('|')}` : '';
}

function refuseAttrs(spec: ComponentSpec, attrs: Record<string, string>): Record<string, string> {
  const parsed = spec.attrs.safeParse(attrs);
  if (parsed.success) return parsed.data as Record<string, string>;
  const first = parsed.error.issues[0];
  const attr = first?.path[0] === undefined ? '' : String(first.path[0]);
  const where = attr ? `\`${spec.name}@${attr}\`` : `\`<${spec.name}>\``;
  const got = attr && attr in attrs ? ` (got "${attrs[attr]}")` : '';
  throw new BodyInvalidError(
    `${where}: ${first?.message ?? 'invalid attribute'}${got}${attr ? legalValues(spec.attrs, attr) : ''}`,
    { element: spec.name, attribute: attr || undefined },
  );
}

/**
 * Where a component is allowed to stand. `parent` is the enclosing component
 * spec, or null at the top level of the body.
 */
function refuseMisplaced(spec: ComponentSpec, parent: ComponentSpec | null): void {
  if (spec.leaf) return;
  if (!parent) {
    if (spec.root) return;
    throw new BodyInvalidError(
      `\`<${spec.name}>\` is a slot, not a body — it may only appear inside a component that declares it. Root components: ${ROOT_COMPONENT_NAMES.join(', ')}`,
      { element: spec.name },
    );
  }
  if (parent.slots.some((s) => s.component === spec.name)) return;
  const declared = parent.slots.map((s) => s.component).join(', ') || 'no child components';
  throw new BodyInvalidError(
    `\`<${spec.name}>\` is not a slot of \`<${parent.name}>\` — it declares ${declared}`,
    { element: spec.name, parent: parent.name },
  );
}

function refuseSlots(spec: ComponentSpec, children: BodyNode[]): void {
  const order: number[] = [];
  const counts = new Map<string, number>();
  for (const child of children) {
    if (child.type !== 'element' || !isComponentName(child.name)) continue;
    const index = spec.slots.findIndex((s) => s.component === child.name);
    if (index === -1) continue;
    counts.set(child.name, (counts.get(child.name) ?? 0) + 1);
    order.push(index);
  }
  for (const slot of spec.slots) {
    const n = counts.get(slot.component) ?? 0;
    if (slot.required && n === 0) {
      throw new BodyInvalidError(
        `\`<${spec.name}>\` is missing its required slot \`<${slot.component}>\``,
        { element: spec.name, slot: slot.component },
      );
    }
    if (!slot.repeat && n > 1) {
      throw new BodyInvalidError(`\`<${spec.name}>\` takes one \`<${slot.component}>\`, got ${n}`, {
        element: spec.name,
        slot: slot.component,
      });
    }
  }
  if (!spec.ordered) return;
  for (let i = 1; i < order.length; i += 1) {
    const previous = order[i - 1] as number;
    const current = order[i] as number;
    if (current < previous) {
      throw new BodyInvalidError(
        `\`<${spec.name}>\` fixes its slot order: \`<${spec.slots[current]?.component}>\` must come before \`<${spec.slots[previous]?.component}>\``,
        { element: spec.name },
      );
    }
  }
}

function cleanPlainAttrs(
  tag: string,
  attrs: Record<string, string>,
  sink: Sink,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(attrs)) {
    if (!plainAttrAllowed(tag, name)) {
      sink.warn(`dropped attribute \`${name}\` on \`<${tag}>\``);
      continue;
    }
    if (URL_ATTRS.has(name) && !urlAllowed(value)) {
      sink.warn(`dropped \`${name}\` on \`<${tag}>\` — only http, https, relative, # and mailto`);
      continue;
    }
    out[name] = value;
  }
  return out;
}

function walk(nodes: BodyNode[], parent: ComponentSpec | null, sink: Sink): BodyNode[] {
  const out: BodyNode[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      out.push(node);
      continue;
    }
    if (node.type === 'comment') {
      sink.warn('removed an HTML comment');
      continue;
    }
    if (DROPPED_ELEMENTS.has(node.name)) {
      sink.warn(`removed \`<${node.name}>\` and its content`);
      continue;
    }
    if (isComponentName(node.name)) {
      out.push(component(node, parent, sink));
      continue;
    }
    if (!PLAIN_TAGS.has(node.name)) {
      sink.warn(`unwrapped unknown tag \`<${node.name}>\``);
      out.push(...walk(node.children, parent, sink));
      continue;
    }
    out.push({
      type: 'element',
      name: node.name,
      attrs: cleanPlainAttrs(node.name, node.attrs, sink),
      children: walk(node.children, parent, sink),
    });
  }
  return out;
}

function component(
  node: Extract<BodyNode, { type: 'element' }>,
  parent: ComponentSpec | null,
  sink: Sink,
): BodyNode {
  const spec = specFor(node.name);
  if (!spec) {
    throw new BodyInvalidError(
      `\`<${node.name}>\` is not a Forge component. Root components: ${ROOT_COMPONENT_NAMES.join(', ')}`,
      { element: node.name },
    );
  }
  refuseMisplaced(spec, parent);
  const attrs = refuseAttrs(spec, node.attrs);
  if (spec.raw) {
    return { type: 'element', name: spec.name, attrs, children: node.children };
  }
  refuseSlots(spec, node.children);
  return { type: 'element', name: spec.name, attrs, children: walk(node.children, spec, sink) };
}

function viewOf(node: Extract<BodyNode, { type: 'element' }>, spec: ComponentSpec): ComponentView {
  const slots: Record<string, ComponentView[]> = {};
  let prose = '';
  for (const child of node.children) {
    if (child.type === 'text') {
      prose += child.value;
      continue;
    }
    if (child.type !== 'element') continue;
    const slot = spec.slots.find((s) => s.component === child.name);
    const childSpec = specFor(child.name);
    if (slot && childSpec) {
      const bucket = slots[slot.key] ?? [];
      bucket.push(viewOf(child, childSpec));
      slots[slot.key] = bucket;
      continue;
    }
    prose += proseTextOf([child]);
  }
  return { name: spec.name, attrs: node.attrs, prose, slots };
}

function proseTextOf(nodes: BodyNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') out += node.value;
    else if (node.type === 'element') {
      const spec = specFor(node.name);
      out += spec ? `\n${spec.toText(viewOf(node, spec))}\n` : proseTextOf(node.children);
      if (node.name === 'p' || node.name === 'br' || node.name === 'li') out += '\n';
    }
  }
  return out;
}

function slotRecord(view: ComponentView, spec: ComponentSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { ...view.attrs };
  const text = view.prose.trim();
  if (text) out.text = text;
  for (const slot of spec.slots) {
    const children = view.slots[slot.key] ?? [];
    const childSpec = specFor(slot.component);
    if (children.length === 0 || !childSpec) continue;
    const records = children.map((c) => slotRecord(c, childSpec));
    out[slot.key] = slot.repeat ? records : records[0];
  }
  return out;
}

/** The one root component of a body, when it has exactly one and nothing else. */
function rootComponent(nodes: BodyNode[]): Extract<BodyNode, { type: 'element' }> | null {
  const meaningful = nodes.filter((n) => n.type !== 'text' || n.value.trim().length > 0);
  const only = meaningful.length === 1 ? meaningful[0] : undefined;
  if (only?.type !== 'element' || !isComponentName(only.name)) return null;
  return specFor(only.name)?.root ? only : null;
}

export function validateBody(nodes: BodyNode[]): ValidatedBody {
  const sink = new Sink();
  const clean = walk(nodes, null, sink);
  const root = rootComponent(clean);
  const spec = root ? specFor(root.name) : undefined;
  return {
    nodes: clean,
    warnings: sink.warnings,
    template: spec ? spec.name : null,
    slots: root && spec ? slotRecord(viewOf(root, spec), spec) : null,
  };
}

/** The compact text projection every read path shares. */
export function bodyToText(nodes: BodyNode[]): string {
  return proseTextOf(nodes)
    .split('\n')
    .map((line) => line.trim())
    .filter((line, i, all) => line.length > 0 || (i > 0 && (all[i - 1]?.length ?? 0) > 0))
    .join('\n')
    .trim();
}
