// What the module standing reads from the design context: the project's feedback list. The
// composition root provides it at boot.

import type { FeedbackListResponse, FeedbackRefusal } from '@forge/contracts/feedback';
import type { ActorAgency } from '@forge/contracts/permissions';

export interface LabelPorts {
  listFeedbackAs: (
    viewer: { userId: string; agency: ActorAgency },
    projectId: string,
  ) => Promise<
    { ok: true; list: FeedbackListResponse } | { ok: false; refusals: FeedbackRefusal[] }
  >;
}

let provided: LabelPorts | null = null;

export function provideLabelPorts(given: LabelPorts): void {
  provided = given;
}

function labelPorts(): LabelPorts {
  if (!provided) {
    throw new Error(
      'labels: no ports were provided; the process entry calls provideLabelPorts before it serves',
    );
  }
  return provided;
}

export const listFeedbackAs: LabelPorts['listFeedbackAs'] = (viewer, projectId) =>
  labelPorts().listFeedbackAs(viewer, projectId);
