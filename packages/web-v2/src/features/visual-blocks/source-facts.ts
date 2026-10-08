import { type ExecutionFacts, ExecutionFactsSchema } from "@forge/contracts/report-executions";
import { type ReportRunFacts, ReportRunFactsSchema } from "@forge/contracts/report-queries";
import type { BlockSource } from "@forge/contracts/visual-blocks";
import type { SourceFacts } from "./context";

/**
 * The query and read time of every run the given messages' visual blocks were drawn from, as core
 * copied them from `report_runs` when it posted each block, looked up by the block's source.
 */
export function runFactsIn(
  messages: readonly { blocks?: readonly unknown[] | null | undefined }[],
): (source: BlockSource) => SourceFacts | undefined {
  const byRun = new Map<string, ReportRunFacts>();
  for (const m of messages) {
    for (const b of m.blocks ?? []) {
      if (b === null || typeof b !== "object" || (b as { type?: unknown }).type !== "visual") continue;
      const parsed = ReportRunFactsSchema.safeParse((b as { run?: unknown }).run);
      if (parsed.success) byRun.set(parsed.data.runId, parsed.data);
    }
  }
  return (source) => ("runId" in source ? byRun.get(source.runId) : undefined);
}

/**
 * Who asked each computation the given messages' visual blocks were drawn from, and every read it
 * made of Forge, as core copied them when it attached the block. A block stored before they were
 * copied has neither, and is drawn without them rather than with a guess.
 */
export function executionFactsIn(
  messages: readonly { blocks?: readonly unknown[] | null | undefined }[],
): (source: BlockSource) => ExecutionFacts | undefined {
  const byExecution = new Map<string, ExecutionFacts>();
  for (const m of messages) {
    for (const b of m.blocks ?? []) {
      if (b === null || typeof b !== "object" || (b as { type?: unknown }).type !== "visual") continue;
      const parsed = ExecutionFactsSchema.safeParse((b as { execution?: unknown }).execution);
      if (parsed.success) byExecution.set(parsed.data.executionId, parsed.data);
    }
  }
  return (source) => ("executionId" in source ? byExecution.get(source.executionId) : undefined);
}
