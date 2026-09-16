/**
 * ISS-1057 — the assistant's instructions as layers, and the one function that reads them.
 *
 * A layer is a module holding one text constant and its header and no other code; this file
 * holds the type and the composer, and is the only reader of a layer's text. What a door
 * renders is a list of layers in an order, so a change to the tool rules is a change to one
 * file that one set of benchmark tasks measures, rather than a change to every door's prose.
 */

/** The layers this repository ships, in the order a door renders them. */
export const LAYER_IDS = [
  'identity',
  'base',
  'tools',
  'linking',
  'door-web',
  'door-web-agent',
  'door-rocketchat',
] as const;
export type LayerId = (typeof LAYER_IDS)[number];

export interface PromptLayer {
  readonly id: LayerId;
  /**
   * The benchmark tasks that exercise this layer — the header ISS-1057 requires, so a change
   * here names the pass^k figures a before/after compare has to move.
   */
  // cm:guard held to `loadTasks()`'s own ids by `compose.test.ts`, never to a hand-kept list: a
  // header naming a task the benchmark no longer ships points a reader at a measurement nobody
  // can take, which is worse than naming none (ISS-1057).
  readonly benchTasks: readonly string[];
  /**
   * Why no shipped task measures this layer. Required exactly where `benchTasks` is empty, so a
   * layer nothing measures says so in its own field rather than borrowing another door's task id.
   */
  readonly whyUnmeasured?: string;
  /** The layer's whole text. `{token}` marks a value the composer fills. */
  readonly text: string;
}

/**
 * What a door knows about itself. A key whose value is `null` drops the line that reads it; a
 * key absent from the map altogether is a fault, not an absence.
 */
export type LayerValues = Readonly<Record<string, string | null>>;

// cm:guard `\w+` only, so a JSON example carrying braces (`{"argv":["new"]}`) is not a placeholder:
// a layer that shows the model a tool call has to be able to print one (ISS-1057).
const PLACEHOLDER_RE = /\{(\w+)\}/g;

export class LayerComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayerComposeError';
  }
}

/** Every `{token}` a layer reads, in the order they appear. */
export function placeholdersOf(layer: PromptLayer): string[] {
  return [...new Set([...layer.text.matchAll(PLACEHOLDER_RE)].map((m) => m[1] as string))];
}

// cm:guard an unnamed placeholder THROWS and a null one drops its line, and the two may not be
// folded together: dropping on both makes a typo in a token an instruction that silently leaves
// the persona, which is the one failure a reader of the rendered text cannot see. The loud break
// belongs where the gap is (ISS-1057, CLAUDE.md "a loud break beats a silent substitution").
function renderLine(line: string, layer: PromptLayer, values: LayerValues): string | null {
  const tokens = [...line.matchAll(PLACEHOLDER_RE)].map((m) => m[1] as string);
  for (const token of tokens) {
    if (!Object.hasOwn(values, token)) {
      throw new LayerComposeError(
        `assistant prompt: layer "${layer.id}" reads {${token}}, which the door composing it does not name; the doors name ${Object.keys(values).sort().join(', ') || 'nothing'}`,
      );
    }
    if (values[token] === null) return null;
  }
  return line.replace(PLACEHOLDER_RE, (_, token: string) => values[token] as string);
}

/** One layer's text, filled, with the lines its absent values drop taken out. */
export function renderLayer(layer: PromptLayer, values: LayerValues): string {
  const kept: string[] = [];
  for (const line of layer.text.split('\n')) {
    const rendered = renderLine(line, layer, values);
    if (rendered !== null) kept.push(rendered);
  }
  return kept.join('\n').trim();
}

/**
 * The layers, in the order given, filled from one values map, separated by a blank line.
 */
// cm:guard the ORDER is the caller's and this function invents none: the doors render identity,
// base, tools, linking and then their own layer, and a composer that sorted or deduplicated
// would make the rendered order a property of this file rather than of the door that owns it.
export function composeLayers(layers: readonly PromptLayer[], values: LayerValues = {}): string {
  return layers
    .map((layer) => renderLayer(layer, values))
    .filter((text) => text.length > 0)
    .join('\n\n');
}
