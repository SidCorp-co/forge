/**
 * ISS-950 (Tier 3c of ISS-587) — the reader for the Mermaid flow a module stores in its knowledge
 * node body. The user-flow and swimlane diagrams are composed of these; the mindmap and the
 * context diagram never reach here.
 *
 * A module's flow is the FIRST fenced ```mermaid block in the node body. The subset understood is
 * `flowchart`/`graph` with `A --> B` and `A -->|label| B`, node text in `[...]`, `(...)` or
 * `{...}`. Everything else is refused by name.
 */

export interface FlowStep {
  id: string;
  label: string;
}

export interface FlowArrow {
  from: string;
  to: string;
  label: string | null;
}

export interface ModuleFlow {
  steps: FlowStep[];
  arrows: FlowArrow[];
}

export class ModuleFlowParseError extends Error {
  constructor(
    readonly line: string,
    message: string,
  ) {
    super(message);
    this.name = 'ModuleFlowParseError';
  }
}

const FENCE = /^```[ \t]*mermaid[ \t]*$/i;
const HEADER = /^(flowchart|graph)\b/i;
const ARROW = /^(.+?)\s*-->\s*(?:\|([^|]*)\|)?\s*(.+)$/;
const NODE = /^([A-Za-z0-9_-]+)(?:\[(.*)\]|\((.*)\)|\{(.*)\})?$/;

/** The body of the first ```mermaid fence, or null when the node stores no flow at all. */
export function extractMermaidBlock(body: string): string | null {
  const lines = body.split('\n');
  const open = lines.findIndex((l) => FENCE.test(l.trim()));
  if (open === -1) return null;
  const rest = lines.slice(open + 1);
  const close = rest.findIndex((l) => l.trim().startsWith('```'));
  return (close === -1 ? rest : rest.slice(0, close)).join('\n');
}

// cm:guard a node id met twice keeps the FIRST text it was given — a later bare `B` must not blank the text `B[Review]` already carried, which is what a plain overwrite would do and what makes a second render of the same body differ from the first.
function remember(steps: Map<string, FlowStep>, id: string, label: string | undefined): void {
  const text = label === undefined || label === '' ? null : label;
  const existing = steps.get(id);
  if (!existing) {
    steps.set(id, { id, label: text ?? id });
    return;
  }
  if (text !== null && existing.label === id) steps.set(id, { id, label: text });
}

function readNode(raw: string, steps: Map<string, FlowStep>): string {
  const m = NODE.exec(raw.trim());
  if (!m?.[1]) {
    throw new ModuleFlowParseError(raw.trim(), `cannot read \`${raw.trim()}\` as a flow step`);
  }
  const id = m[1];
  remember(steps, id, m[2] ?? m[3] ?? m[4]);
  return id;
}

// cm:guard the refusal is the whole point of this function — every unreadable line throws, and no branch here returns "the arrows it managed to read". The issue's rule is that a generator which cannot render what it was asked for says so by name rather than answering with a partial diagram that looks complete, and a `continue` in this loop is exactly that partial diagram.
/**
 * Parse the subset. `null` in, `null` out: a node that stores no flow is not an error, and the
 * caller decides whether an absent flow is a refusal (`user-flow` with no flows anywhere) or
 * simply a module that contributes nothing to this diagram.
 */
export function parseModuleFlow(body: string): ModuleFlow | null {
  const block = extractMermaidBlock(body);
  if (block === null) return null;

  const steps = new Map<string, FlowStep>();
  const arrows: FlowArrow[] = [];
  let sawHeader = false;

  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('%%')) continue;
    if (!sawHeader) {
      if (!HEADER.test(line)) {
        throw new ModuleFlowParseError(
          line,
          `flow must open with \`flowchart\` or \`graph\`, not \`${line}\``,
        );
      }
      sawHeader = true;
      continue;
    }
    const arrow = ARROW.exec(line);
    if (!arrow?.[1] || !arrow[3]) {
      throw new ModuleFlowParseError(line, `cannot read \`${line}\` as a flow arrow`);
    }
    const from = readNode(arrow[1], steps);
    const to = readNode(arrow[3], steps);
    arrows.push({ from, to, label: arrow[2]?.trim() || null });
  }

  if (!sawHeader) return null;
  return { steps: [...steps.values()], arrows };
}
