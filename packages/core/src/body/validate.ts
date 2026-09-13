/**
 * Sanitize, then refuse — two rules with two different outcomes, and mixing
 * them up is the failure this module exists to avoid.
 *
 * **Plain markup is repaired and reported.** An unknown tag is unwrapped, a
 * disallowed attribute dropped, a `<script>` removed whole, each one named in
 * `warnings[]`. It is never a refusal, because prose must always be valid — a
 * human who types a `<div>` must not be told no.
 *
 * **`forge-*` markup is refused and named.** The component vocabulary was
 * removed on 2026-09-14; a caller still sending one is told that by name rather
 * than having it unwrapped into prose, because a body silently stripped of the
 * structure its author meant is the substitution this repo refuses everywhere.
 */

import { BodyInvalidError } from './errors.js';
import type { BodyNode } from './parse.js';
import { DROPPED_ELEMENTS, PLAIN_TAGS, plainAttrAllowed, urlAllowed } from './plain-tags.js';

export interface ValidatedBody {
  nodes: BodyNode[];
  warnings: string[];
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

// cm:guard REFUSED by name and never unwrapped like any other unknown tag: the component set was removed (2026-09-14) and a caller still emitting `<forge-review>` is a caller whose structure would be silently flattened into prose — the reading it meant, gone, with a 200 and a warning nobody reads. `forge-plugin` skills are the callers this is aimed at, and they reach this over the wire.
function refuseComponent(name: string): never {
  throw new BodyInvalidError(
    `\`<${name}>\` is not markup this server accepts — the forge-* component set was removed on 2026-09-14. Send markdown, or plain HTML from the allowlist.`,
    { element: name },
  );
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

function walk(nodes: BodyNode[], sink: Sink): BodyNode[] {
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
    if (node.name.startsWith('forge-')) refuseComponent(node.name);
    if (!PLAIN_TAGS.has(node.name)) {
      sink.warn(`unwrapped unknown tag \`<${node.name}>\``);
      out.push(...walk(node.children, sink));
      continue;
    }
    out.push({
      type: 'element',
      name: node.name,
      attrs: cleanPlainAttrs(node.name, node.attrs, sink),
      children: walk(node.children, sink),
    });
  }
  return out;
}

export function validateBody(nodes: BodyNode[]): ValidatedBody {
  const sink = new Sink();
  return { nodes: walk(nodes, sink), warnings: sink.warnings };
}

function proseTextOf(nodes: BodyNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') out += node.value;
    else if (node.type === 'element') {
      out += proseTextOf(node.children);
      if (node.name === 'p' || node.name === 'br' || node.name === 'li') out += '\n';
    }
  }
  return out;
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
