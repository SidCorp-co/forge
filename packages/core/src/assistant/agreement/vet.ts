// A held write's own check, made before its card is offered (REQ-30 BC-4 with REQ-35 BC-10): the
// turn gate holds a write without running it, so a call its press would only see refused is refused
// now, by the tool's own rule, and the model corrects it in the same turn rather than the person
// pressing Record it on a card that fails. A record tool of a module the assistant may not import
// hands its check over at boot, beside the tool itself (`provideChatTools`).

import { RefusalError } from '../../lib/refusal.js';
import { refusedAnswer } from '../../lib/tool.js';
import { type CallToolResult, toToolCallContent } from '../../lib/tool-result.js';
import { thrownMessage, toolError } from '../tools/mcp-adapter.js';

/** The answer the call would be refused with, as its tool answers one, or null to hold it. */
export type HeldWriteVet = (args: Record<string, unknown>) => Promise<unknown | null>;

const vets = new Map<string, HeldWriteVet>();

/** The process entry hands each record tool's check over by the tool's name. */
export function provideHeldWriteVets(entries: Readonly<Record<string, HeldWriteVet>>): void {
  for (const [name, vet] of Object.entries(entries)) vets.set(name, vet);
}

/**
 * What a call the gate is about to hold is refused for: its own tool's check, run with the turn's
 * project pinned as the toolset pins it. Null where the call may be held, or its tool has no check.
 */
export async function vetHeld(
  name: string,
  argsJson: string,
  projectId: string,
): Promise<CallToolResult | null> {
  const vet = vets.get(name);
  if (!vet) return null;
  let args: Record<string, unknown>;
  try {
    const parsed = argsJson.trim() ? (JSON.parse(argsJson) as unknown) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return toolError('arguments were not a JSON object');
    }
    args = { ...(parsed as Record<string, unknown>), projectId };
  } catch {
    return toolError('arguments were not valid JSON');
  }
  try {
    const refused = await vet(args);
    return refused === null ? null : toToolCallContent(refused);
  } catch (err) {
    // answered as the toolset answers a throw (`mcp-adapter.ts:callTool`)
    if (err instanceof RefusalError) {
      return toToolCallContent(refusedAnswer(err.refusals, err.fallbackCode));
    }
    return toolError(thrownMessage(err));
  }
}
