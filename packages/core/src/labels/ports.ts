// What the module standing reads from the design context: the project's feedback list. The
// composition root provides it at boot.

import type { FeedbackListResponse, FeedbackRefusal } from '@forge/contracts/feedback';
import type { ActorAgency } from '@forge/contracts/permissions';
import { portSlot } from '../lib/port-slot.js';

interface LabelPorts {
  listFeedbackAs: (
    viewer: { userId: string; agency: ActorAgency },
    projectId: string,
  ) => Promise<
    { ok: true; list: FeedbackListResponse } | { ok: false; refusals: FeedbackRefusal[] }
  >;
}

const slot = portSlot<LabelPorts>('labels', 'provideLabelPorts');
export const provideLabelPorts = slot.provide;
const { port } = slot;

export const listFeedbackAs = port('listFeedbackAs');
