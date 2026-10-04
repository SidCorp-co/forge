import type { MeasuredChange } from './diff.js';
import { diffSchema } from './schema-diff.js';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

interface ListedTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export function toolsOf(doc: unknown): Map<string, ListedTool> | null {
  if (!isObject(doc) || !Array.isArray(doc.tools)) return null;
  const tools = new Map<string, ListedTool>();
  for (const t of doc.tools) {
    if (!isObject(t) || typeof t.name !== 'string' || !isObject(t.inputSchema)) return null;
    tools.set(t.name, t as unknown as ListedTool);
  }
  return tools;
}

export function diffMcpTools(
  o: Map<string, ListedTool>,
  n: Map<string, ListedTool>,
): MeasuredChange[] {
  const out: MeasuredChange[] = [];
  for (const [name, tool] of o) {
    const next = n.get(name);
    if (!next) {
      out.push({
        element: name,
        kind: 'removed',
        level: 'breaking',
        text: `tool ${name} was removed`,
        check: 'tool-removed',
      });
      continue;
    }
    if (tool.description !== next.description)
      out.push({
        element: name,
        kind: 'changed',
        level: 'info',
        text: 'the description changed',
        check: 'tool-description-changed',
      });
    out.push(...diffSchema(name, tool.inputSchema, next.inputSchema));
  }
  for (const name of n.keys()) {
    if (!o.has(name))
      out.push({
        element: name,
        kind: 'added',
        level: 'info',
        text: `tool ${name} was added`,
        check: 'tool-added',
      });
  }
  return out;
}
