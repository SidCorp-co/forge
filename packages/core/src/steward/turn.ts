// One steward act as a core gateway turn (REQ-48 BC-1): the shared turn loop over the assistant's
// gateway, offered only the act's doors and fenced to the steward origin, acting as the project's
// steward account under a token minted for this act and revoked when it ends. The note runs on the
// fast model, the checks on the default one; no provider key is read here (decision 6).

import type { ItemStanding, StewardAct } from '@forge/contracts/steward';
import { recordModelCallUsage } from '../agent-sessions/index.js';
import { type ChatToolset, fenceToolsetToOrigin, runTurnEvents } from '../assistant/index.js';
import { type ChatStreamUsage, fastModelName, openChat } from '../integrations/llm/index.js';
import { recordAppliedFromText } from '../lessons/index.js';
import type { EgressSurface } from '../lib/data-egress.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { mintStewardCredential, STEWARD_TURN_TTL_MS } from './credential.js';
import { callStewardDoor, type DoorContext, doorJsonSchema, doorsOf } from './doors.js';
import { stewardLessonsBlock } from './lessons-block.js';
import { actContext, actPrompt } from './prompts.js';
import type { RunRow } from './runs-store.js';

const SURFACE: Record<RunRow['subjectKind'], EgressSurface> = {
  requirement: 'requirement',
  feedback: 'feedback',
  issue: 'issue',
};

export interface GatewayActResult {
  /** The writes a door refused, each named with its door and code. */
  refused: string[];
  /** The writes a door could not answer (5xx), which are no refusal. */
  broken: string[];
  /** The act rows written. */
  acts: string[];
  /** Why the turn itself did not finish, or null. */
  error: string | null;
}

/** The act's doors as a toolset, each call made through `callStewardDoor` as the steward. */
export function stewardToolset(ctx: DoorContext, stewardId: string): ChatToolset {
  const doors = doorsOf(ctx.act);
  const set: ChatToolset = {
    tools: doors.map((d) => ({
      type: 'function' as const,
      function: { name: d.name, description: d.describe, parameters: doorJsonSchema(d) },
    })),
    execute: async (name, argsJson) => {
      // the act's own menu, not the whole catalogue: a door another act holds is refused by name
      if (!doors.some((d) => d.name === name)) {
        const error = `${name} is not a door of ${ctx.act}; its doors are ${doors.map((d) => d.name).join(', ')}`;
        return { content: [{ type: 'text', text: JSON.stringify({ error }) }], isError: true };
      }
      const out = await callStewardDoor(name, argsJson, ctx);
      return { content: [{ type: 'text', text: out.text }], ...(out.ok ? {} : { isError: true }) };
    },
    ranAs: () => stewardId,
  };
  return fenceToolsetToOrigin(set, 'steward');
}

async function recordSpend(
  projectId: string,
  model: string,
  usage: ChatStreamUsage,
  rounds: number,
) {
  const cached = usage.cachedPromptTokens ?? 0;
  try {
    await recordModelCallUsage({
      projectId,
      model,
      inputTokens: Math.max(0, (usage.promptTokens ?? 0) - cached),
      outputTokens: usage.completionTokens ?? 0,
      cacheReadTokens: cached,
      requestCount: rounds,
      recordedAt: new Date(),
    });
  } catch (err) {
    logger.warn({ err, projectId }, 'steward: the usage of a gateway act was not recorded');
  }
}

/** Run one gateway act of `run`, and say what it wrote and what was refused. */
export async function runGatewayAct(args: {
  run: RunRow;
  act: StewardAct;
  standing: ItemStanding | null;
  stewardId: string;
}): Promise<GatewayActResult> {
  const { run, act } = args;
  const credential = await mintStewardCredential({
    projectId: run.projectId,
    stewardId: args.stewardId,
    acts: [act],
    ttlMs: STEWARD_TURN_TTL_MS,
  });
  const ctx: DoorContext = {
    projectId: run.projectId,
    runId: run.id,
    act,
    subject: { kind: run.subjectKind, id: run.subjectId, key: run.subjectKey },
    standing: args.standing,
    token: credential.token,
    refused: [],
    broken: [],
    acts: [],
  };
  try {
    const opened = await openChat({
      surface: SURFACE[run.subjectKind],
      projectId: run.projectId,
      what: `steward ${act} on ${run.subjectKey}`,
    });
    const model = act === 'note' ? fastModelName() : opened.model;
    const lessons = await stewardLessonsBlock(run);
    const gen = runTurnEvents({
      provider: opened.provider,
      model,
      messages: [
        { role: 'system', content: lessons ? `${actPrompt(act)}\n\n${lessons}` : actPrompt(act) },
        { role: 'user', content: actContext(run, args.standing) },
      ],
      tools: stewardToolset(ctx, args.stewardId),
      temperature: 0,
      requireInitialToolUse: true,
      contextBudgetTokens: env.CHAT_CONTEXT_BUDGET_TOKENS,
    });
    let step = await gen.next();
    while (!step.done) step = await gen.next();
    const result = step.value;
    await recordSpend(run.projectId, model, result.usage, result.iterations);
    // the lessons its answer says shaped it are kept against the run (REQ-50 BC-4)
    await recordAppliedFromText({
      projectId: run.projectId,
      text: result.finalText,
      output: { kind: 'steward_run', ref: run.id },
      agentUserId: args.stewardId,
    });
    return {
      refused: ctx.refused,
      broken: ctx.broken,
      acts: ctx.acts,
      error:
        result.terminal === 'error' ? (result.errorMessage ?? 'the turn ended in an error') : null,
    };
  } catch (err) {
    return {
      refused: ctx.refused,
      broken: ctx.broken,
      acts: ctx.acts,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await credential.revoke();
  }
}
