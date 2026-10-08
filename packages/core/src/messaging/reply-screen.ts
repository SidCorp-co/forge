import type { Tx } from '../db/client.js';
import type { DoorId, MessageVerdict } from './contract.js';
import { doorCell } from './doors.js';
import type { ProgressFacts, ToolResultEntry } from './facts.js';
import { groundingTexts, isReportTool } from './figures-rule.js';
import { gatherFacts } from './gather.js';
import { withGrounding } from './grounding-rule.js';
import { countsRead } from './progress-rule.js';
import { screenMessage } from './screen.js';
import { memoryDatesRead } from './status-claims-rule.js';

interface ReplyScreenInput {
  readonly projectId: string;
  /** The message as its reader will see it; more than one where it renders as parts. */
  readonly segments: readonly string[];
  readonly toolCalls: readonly {
    name: string;
    arguments: string;
    isError?: boolean;
  }[];
  /** The tools the writer's turn was offered; a rule holding a claim to a read judges only where one was. */
  readonly offeredTools?: readonly string[];
  /**
   * The snapshot the writer's own turn was shown.
   */
  readonly progress: ProgressFacts | null;
  /** A caller inside a transaction MUST pass its own handle. */
  readonly executor?: Tx;
  /**
   * What the writer's own turn read, where the caller has it: a date or status the reply states
   * about the tracker is then held to these (`grounding-rule.ts`).
   */
  readonly toolResults?: readonly string[];
  /**
   * What the person asked. Given, a figure the reply states is held to the turn's report runs
   * (`figures-rule.ts`), where the turn was offered a report tool or `restResults` are given; a
   * number the person typed may be said back.
   */
  readonly question?: string;
  /**
   * An Agent session's tool results: it runs a report over REST rather than through a tool, so its
   * figures are held to the runs these results name.
   */
  readonly restResults?: readonly string[];
  /**
   * The blocks held with this reply, posted with it if it passes. Given, a block's title and labels
   * are read from them rather than from the turn's calls, which name blocks that were refused or
   * belong to an answer this reply replaced.
   */
  readonly heldBlocks?: readonly unknown[];
  /**
   * What each of the turn's calls returned, by the tool's name. Given, the results of the reads
   * `figures-rule.ts:FIGURE_GROUNDING_RESULTS` declares ground a figure as a report run does.
   */
  readonly namedResults?: readonly ToolResultEntry[];
}

/** What the figures rule reads of this turn, or nothing where the turn could run no report. */
function figureInput(
  input: ReplyScreenInput,
  held: readonly string[],
): { asked: string; texts: readonly string[]; reads: readonly string[] } | undefined {
  if (input.question === undefined) return undefined;
  const sent = [
    ...input.toolCalls.filter((c) => c.isError !== true).map((c) => c.arguments),
    ...held,
  ];
  const reads = groundingTexts(input.namedResults ?? []);
  if (input.restResults) {
    return { asked: input.question, texts: [...input.restResults, ...sent], reads };
  }
  if (!input.offeredTools?.some(isReportTool)) return undefined;
  return { asked: input.question, texts: [...(input.toolResults ?? []), ...sent], reads };
}

export async function screenReplyAtDoor(
  door: DoorId,
  input: ReplyScreenInput,
): Promise<MessageVerdict> {
  const { audience, intent } = doorCell(door);
  const held = input.heldBlocks?.map((b) => JSON.stringify(b));
  const figures = figureInput(input, held ?? []);
  const facts = await gatherFacts({
    projectId: input.projectId,
    audience,
    intent,
    segments: input.segments,
    toolCalls: input.toolCalls,
    ...(input.offeredTools ? { offeredTools: input.offeredTools } : {}),
    ...(input.toolResults
      ? {
          readCounts: countsRead(input.toolResults),
          memoryDates: memoryDatesRead(input.toolResults),
        }
      : {}),
    progress: input.progress,
    ...(input.question !== undefined ? { question: input.question } : {}),
    ...(figures ? { figures } : {}),
    ...(held ? { heldBlocks: held } : {}),
    ...(input.executor ? { executor: input.executor } : {}),
  });
  const verdict = screenMessage({ audience, intent, segments: input.segments, facts });
  return input.toolResults
    ? withGrounding(verdict, input.segments, input.toolResults, facts)
    : verdict;
}
