// The Pipeline page's one draft. It is held in the shape the pipeline-config document has, so a path
// the server names in a refusal is a path in the draft, with the defaults the screen shows already
// filled in. What it writes is the difference between two drafts, never the draft itself, so a
// section nobody touched is absent from the body and cannot be refused for a key somebody else moved.

import { z } from "zod";
import { documentWrite } from "./document-write";
import {
  type DocumentWrite,
  PIPELINE_STATUS_ROWS,
  type PipelineConfig,
  type PipelineStateConfig,
  type PluginDesignation,
} from "./types";

export const ENTRY_STATUS = "open";

const DEFAULT_BACKLOG_LIMIT = 20;
const DEFAULT_PROMOTIONS_PER_RUN = 3;
const DEFAULT_MIN_RETRIEVALS = 3;

export interface StageDraft {
  /** The entry stage's two switches, held as stored: absent stays absent until somebody flips them. */
  enabled?: boolean;
  mode?: string;
  disallowedTools: string[];
  allowedTools: string[];
  mcpServers: Record<string, unknown>;
  /** Kept in one order, so choosing the same boxes in another order is not an edit. */
  deviceIds: string[];
}

export interface PipelineDraft {
  enabled?: boolean;
  states: Record<string, StageDraft>;
  mcpServers: Record<string, unknown>;
  intakeGate: { enabled: boolean; notify: boolean };
  poolBacklog: { statuses: string[]; limit: number };
  knowledgePromotion: { enabled: boolean; candidatesPerRun: number; minRetrievals: number };
  assistantWeekly: {
    enabled: boolean;
    pinnedIssue: string;
    judgeProviderId: string;
    judgeModel: string;
    source?: string;
  };
  plugins: PluginDesignation[];
}

const sortedIds = (ids: readonly unknown[] | undefined): string[] =>
  (ids ?? []).filter((d): d is string => typeof d === "string").sort();

function stageOf(status: string, stored: PipelineStateConfig | undefined): StageDraft {
  const st = stored ?? {};
  return {
    ...(status === ENTRY_STATUS ? { enabled: st.enabled, mode: st.mode } : {}),
    disallowedTools: st.disallowedTools ?? [],
    allowedTools: st.allowedTools ?? [],
    mcpServers: st.mcpServers ?? {},
    deviceIds: sortedIds(st.deviceIds),
  };
}

/** The draft a read of the document and of the project's plugins amounts to. */
export function readPipeline(config: PipelineConfig, plugins: PluginDesignation[]): PipelineDraft {
  const stored = (config.states ?? {}) as Record<string, PipelineStateConfig | undefined>;
  const states: Record<string, StageDraft> = {};
  for (const status of new Set([...PIPELINE_STATUS_ROWS.map((r) => r.status), ...Object.keys(stored)])) {
    states[status] = stageOf(status, stored[status]);
  }
  const mcp = config.mcpServers;
  return {
    enabled: config.enabled,
    states,
    mcpServers: mcp && typeof mcp === "object" ? (mcp as Record<string, unknown>) : {},
    intakeGate: {
      enabled: config.intakeGate?.enabled ?? false,
      notify: config.intakeGate?.notify !== false,
    },
    poolBacklog: {
      statuses: config.poolBacklog?.statuses ?? [],
      limit: config.poolBacklog?.limit ?? DEFAULT_BACKLOG_LIMIT,
    },
    knowledgePromotion: {
      enabled: config.knowledgePromotion?.enabled ?? false,
      candidatesPerRun: config.knowledgePromotion?.candidatesPerRun ?? DEFAULT_PROMOTIONS_PER_RUN,
      minRetrievals: config.knowledgePromotion?.minRetrievals ?? DEFAULT_MIN_RETRIEVALS,
    },
    assistantWeekly: {
      enabled: false,
      pinnedIssue: "",
      judgeProviderId: "",
      judgeModel: "",
      ...(config.assistantWeekly ?? {}),
    },
    plugins: plugins.map((p) => ({ ...p })),
  };
}

const emptyToUndefined = <V>(value: readonly V[]): V[] | undefined =>
  value.length > 0 ? [...value] : undefined;

/** The document a draft stands for — only the keys this page renders, and no key it holds empty. */
function configOf(draft: PipelineDraft): Record<string, unknown> {
  const states: Record<string, unknown> = {};
  for (const [status, st] of Object.entries(draft.states)) {
    states[status] = {
      enabled: st.enabled,
      mode: st.mode,
      disallowedTools: emptyToUndefined(st.disallowedTools),
      allowedTools: emptyToUndefined(st.allowedTools),
      mcpServers: Object.keys(st.mcpServers).length > 0 ? st.mcpServers : undefined,
      deviceIds: emptyToUndefined(st.deviceIds),
    };
  }
  const weekly = draft.assistantWeekly;
  const source = weekly.source?.trim();
  return {
    enabled: draft.enabled,
    mcpServers: draft.mcpServers,
    states,
    intakeGate: draft.intakeGate,
    poolBacklog:
      draft.poolBacklog.statuses.length === 0 ? undefined : { ...draft.poolBacklog },
    knowledgePromotion: draft.knowledgePromotion,
    assistantWeekly: {
      enabled: weekly.enabled,
      pinnedIssue: weekly.pinnedIssue.trim(),
      judgeProviderId: weekly.judgeProviderId.trim(),
      judgeModel: weekly.judgeModel.trim(),
      ...(source ? { source } : {}),
    },
  };
}

const pluginOf = (p: PluginDesignation): PluginDesignation => ({
  marketplace: p.marketplace.trim(),
  name: p.name.trim(),
  pinnedRef: p.pinnedRef?.trim() || null,
  autoUpdate: Boolean(p.autoUpdate),
});

export interface PipelineWrites {
  /** The pipeline-config write, or null where no key of that document moved. */
  config: DocumentWrite | null;
  /** The plugins list, to be sent whole, or null where it did not move. */
  plugins: PluginDesignation[] | null;
}

/** What saving owes: the keys the draft moved off what it was seeded with, against the stored document. */
export function pipelineWrites(
  seeded: PipelineDraft,
  held: PipelineDraft,
  stored: PipelineConfig,
): PipelineWrites {
  const heldPlugins = held.plugins.map(pluginOf);
  const seededPlugins = seeded.plugins.map(pluginOf);
  return {
    config: documentWrite(configOf(seeded), configOf(held), stored),
    plugins: JSON.stringify(heldPlugins) === JSON.stringify(seededPlugins) ? null : heldPlugins,
  };
}

/** The shape the page's dirtiness is read in: what would be written, and nothing it would not. */
export function pipelineComparable(draft: PipelineDraft): unknown {
  return { config: configOf(draft), plugins: draft.plugins.map(pluginOf) };
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;

/** What is wrong with one plugin row, in the words the row shows, or null. */
export function pluginRowError(p: PluginDesignation): string | null {
  if (!p.marketplace.trim()) return "Marketplace is required.";
  if (!NAME_RE.test(p.name.trim())) return "Name must be kebab-case.";
  const ref = p.pinnedRef?.trim();
  if (ref && !SHA_RE.test(ref)) return "Pinned SHA must be 7–40 hex characters.";
  return null;
}

const pluginRow = z
  .object({
    marketplace: z.string(),
    name: z.string(),
    pinnedRef: z.string().nullable().optional(),
    autoUpdate: z.boolean().optional(),
  })
  .superRefine((row, ctx) => {
    const message = pluginRowError(row);
    if (message) ctx.addIssue({ code: "custom", message });
  });

const stage = z.object({
  enabled: z.boolean().optional(),
  mode: z.string().optional(),
  disallowedTools: z.array(z.string()),
  allowedTools: z.array(z.string()),
  mcpServers: z.record(z.string(), z.unknown()),
  deviceIds: z.array(z.string()),
});

const whole = (label: string, min: number, max: number) =>
  z
    .number({ error: `${label} must be a whole number from ${min} to ${max}.` })
    .int(`${label} must be a whole number from ${min} to ${max}.`)
    .min(min, `${label} must be at least ${min}.`)
    .max(max, `${label} must be at most ${max}.`);

export const WEEKLY_INCOMPLETE =
  "Fill in the pinned issue, the judge provider id and the judge model before turning the weekly reading on.";
export const BACKLOG_NEEDS_INTAKE_GATE_OFF =
  "Intake gate is on, which parks every new issue at Draft for a human to approve. A master that may promote drafts is that human, so Draft can’t also be admitted here — turn the intake gate off, or drop Draft from this list.";

export const pipelineSchema: z.ZodType<PipelineDraft, PipelineDraft> = z
  .object({
    enabled: z.boolean().optional(),
    states: z.record(z.string(), stage),
    mcpServers: z.record(z.string(), z.unknown()),
    intakeGate: z.object({ enabled: z.boolean(), notify: z.boolean() }),
    poolBacklog: z.object({
      statuses: z.array(z.string()),
      limit: whole("Backlog rows", 1, 100),
    }),
    knowledgePromotion: z.object({
      enabled: z.boolean(),
      candidatesPerRun: whole("Proposals per night", 1, 10),
      minRetrievals: whole("Retrievals", 1, 100),
    }),
    assistantWeekly: z.object({
      enabled: z.boolean(),
      pinnedIssue: z.string(),
      judgeProviderId: z.string(),
      judgeModel: z.string(),
      source: z.string().optional(),
    }),
    plugins: z.array(pluginRow),
  })
  .superRefine((draft, ctx) => {
    const weekly = draft.assistantWeekly;
    const complete =
      weekly.pinnedIssue.trim() !== "" &&
      weekly.judgeProviderId.trim() !== "" &&
      weekly.judgeModel.trim() !== "";
    if (weekly.enabled && !complete) {
      ctx.addIssue({ code: "custom", path: ["assistantWeekly", "enabled"], message: WEEKLY_INCOMPLETE });
    }
    if (draft.intakeGate.enabled && draft.poolBacklog.statuses.includes("draft")) {
      ctx.addIssue({
        code: "custom",
        path: ["poolBacklog", "statuses"],
        message: BACKLOG_NEEDS_INTAKE_GATE_OFF,
      });
    }
  });
