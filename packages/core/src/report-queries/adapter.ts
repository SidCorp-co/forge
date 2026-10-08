// What one report query is in core: its contract descriptor, the existing reads it summarises, and
// the function that runs it as the asker. The registry (lane A2) collects these; a query never
// computes a fact an existing read already decides.

import type { ReportFrame, ReportQueryDescriptor } from '@forge/contracts/report-queries';
import { ReportFrameSchema } from '@forge/contracts/report-queries';
import type { z } from 'zod';
import type { StatusViewer } from '../project-status/index.js';

/** The asker: every read a query calls checks its own permission as this viewer. */
export interface ReportQueryContext {
  projectId: string;
  viewer: StatusViewer;
  /** The moment the read answers as; the run stamps its provenance with the same one. */
  now?: Date;
}

export interface ReportQueryAdapter<P extends z.ZodObject = z.ZodObject> {
  descriptor: ReportQueryDescriptor<P>;
  /**
   * The existing reads this query calls, as `module:function`. A query that calls a read SELECTs no
   * table of its own, so `modules.json` declares none for it; a query that ever SELECTs one names
   * the table there and the read here.
   */
  reads: readonly string[];
  run(ctx: ReportQueryContext, params: z.infer<P>): Promise<ReportFrame>;
}

export const defineAdapter = <P extends z.ZodObject>(
  adapter: ReportQueryAdapter<P>,
): ReportQueryAdapter<P> => {
  if (adapter.reads.length === 0) {
    throw new Error(
      `report query "${adapter.descriptor.id}": reads is empty; name the existing read it calls as module:function, or the table it SELECTs in modules.json`,
    );
  }
  return adapter;
};

/** A frame the contract refuses is never returned: the refusal names the query and the rule. */
export function checkedFrame(id: string, frame: ReportFrame): ReportFrame {
  const parsed = ReportFrameSchema.safeParse(frame);
  if (!parsed.success) {
    throw new Error(
      `report query "${id}" built a frame its own contract refuses: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return parsed.data;
}
