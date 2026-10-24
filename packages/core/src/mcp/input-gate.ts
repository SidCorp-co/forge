// The one path every /mcp tool's input meets (REQ-73 BC-5): a tool's own named refusal stands, and a
// validator error a handler lets escape is answered here, by the registry, in the same refusal form
// forge_feedback gives (ISS-562), so no tool answers a wrong argument with a validator dump. The
// answer names paths and the valid shape, never a value the caller sent, and a key the caller named
// is scrubbed, so a credential sent in the wrong place does not come back.

import type { McpToolName } from '@forge/contracts/mcp-tools';
import { scrubLogText } from '@forge/observability';
import { z } from 'zod';
import { jsonPointer, type Refusal, RefusalError } from '../lib/refusal.js';
import { declaredInputOf, type McpTool } from '../lib/tool.js';

/**
 * The tools whose published input is written by hand and whose handler judges every argument
 * itself, per action, under a code of its own. Any other tool's input is built with
 * `lib/tool.ts:zodToMcpSchema`, so the gate can judge the call against it.
 */
export const JUDGES_OWN_ARGUMENTS: Readonly<Partial<Record<McpToolName, string>>> = {
  forge_ecosystem:
    'each action takes its own strict input, refused ECOSYSTEM_ARGUMENT_INVALID (ecosystem/tool-args.ts:parse)',
  forge_channel:
    'each action takes its own strict input, refused CHANNEL_ARGUMENT_INVALID (ecosystem/channel-tool-args.ts:parseChannelCall)',
};

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  format?: string;
  default?: unknown;
};

const NESTING_SHOWN = 2;

/** A published input schema as the one line a refusal names: `{ data: { target: "issue" | ..., attachmentId: uuid }, note?: string }`. */
export function shapeOf(schema: JsonSchema, depth = 0): string {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives) return alternatives.map((a) => shapeOf(a, depth)).join(' | ');
  if (schema.properties) {
    if (depth >= NESTING_SHOWN) return '{ ... }';
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties).map(
      ([key, inner]) => `${key}${required.has(key) ? '' : '?'}: ${shapeOf(inner, depth + 1)}`,
    );
    return `{ ${fields.join(', ')} }`;
  }
  const type = Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type;
  if (type === 'array') {
    const item = schema.items ? shapeOf(schema.items, depth + 1) : 'unknown';
    return item.includes(' | ') ? `(${item})[]` : `${item}[]`;
  }
  if (type === 'string' && schema.format) return schema.format;
  return type ?? 'unknown';
}

/**
 * Each fault of a refused call at its own path, with the valid shape. A key the call sent that the
 * input does not take is named at its path; the value at a path is never read, and every key named
 * passes the secret scrubber, so the answer carries nothing the caller sent but the key's name.
 */
export function argumentRefusals(
  tool: string,
  issues: readonly z.core.$ZodIssue[],
  shape: string,
): Refusal[] {
  const row = (path: readonly PropertyKey[], fault: string): Refusal => ({
    code: 'BAD_REQUEST',
    path: scrubLogText(jsonPointer(path)),
    detail: scrubLogText(`${fault}; ${tool} takes ${shape}`),
  });
  return issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) =>
          row([...issue.path, key], `\`${key}\` is not an argument of ${tool}`),
        )
      : [row(issue.path, issue.message)],
  );
}

/**
 * A call naming an action the tool's published input does not take, or none where it has no
 * default, refused by name before its grant is read: an action that does not exist has no grant to
 * check, and the answer is the caller's input, never a FORBIDDEN. The action sent is never echoed.
 */
export function actionRefusal(tool: McpTool, args: Record<string, unknown>): RefusalError | null {
  const input = tool.inputSchema as JsonSchema;
  const action = input.properties?.action;
  const takes = action?.enum ?? (action?.const !== undefined ? [action.const] : null);
  if (!action || !takes) return null;
  const sent = args.action;
  if (sent === undefined && action.default !== undefined) return null;
  if (typeof sent === 'string' && takes.includes(sent)) return null;
  const shape = shapeOf(input);
  const fault = sent === undefined ? '`action` is required' : '`action` is not one this tool takes';
  const one = takes.map((a) => JSON.stringify(a)).join(' | ');
  return new RefusalError(
    [
      {
        code: 'BAD_REQUEST',
        path: '/action',
        detail: `${fault}: one of ${one}; ${tool.name} takes ${shape}`,
      },
    ],
    'BAD_REQUEST',
    `${tool.name} takes ${shape}`,
  );
}

/**
 * The tool the registry serves: its handler, behind the gate. A validator error escaping the
 * handler is judged against the tool's declared input: where that refuses the call, the caller is
 * answered by name (BAD_REQUEST at each fault's path, with the valid shape); where it does not, the
 * error came from Forge's own data, and it is logged and answered as Forge's fault, never dumped.
 */
export function gatedTool(tool: McpTool): McpTool {
  const declared = declaredInputOf(tool.inputSchema);
  if (!declared && !(tool.name in JUDGES_OWN_ARGUMENTS)) {
    throw new Error(
      `mcp registry: ${tool.name} publishes an input no validator stands behind, so a wrong argument would reach the caller unnamed; build its inputSchema with zodToMcpSchema (lib/tool.ts), or name it in JUDGES_OWN_ARGUMENTS (mcp/input-gate.ts) with the code its own refusal answers under`,
    );
  }
  const shape = shapeOf(tool.inputSchema as JsonSchema);
  return {
    ...tool,
    handler: async (args) => {
      try {
        return await tool.handler(args);
      } catch (err) {
        if (!(err instanceof z.core.$ZodError)) throw err;
        const judged = declared?.safeParse(args);
        if (judged && !judged.success) {
          throw new RefusalError(
            argumentRefusals(tool.name, judged.error.issues, shape),
            'BAD_REQUEST',
            scrubLogText(`${tool.name} takes ${shape}`),
          );
        }
        console.error(
          `[@forge/core mcp] ${tool.name}: a validator refused data the call did not send`,
          err.issues.map((i) => ({ code: i.code, path: jsonPointer(i.path) })),
        );
        throw new Error(
          `${tool.name} could not read its own data: a fault in Forge, not in this call, and it is logged`,
        );
      }
    },
  };
}
