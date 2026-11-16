// What the labels module reaches downstream of the work context: the project's feedback list (the
// module standing), and the setters of a requirement's and a reference source's module (the module
// map's placement door, ISS-1256), owned by Product design and Conversations. The composition root
// provides them at boot.

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
  /** Set REQ-`reqSeq`'s module; undefined where the project holds no such requirement. */
  setRequirementModule: (
    projectId: string,
    reqSeq: number,
    moduleId: string | null,
  ) => Promise<{ previous: string | null; title: string } | undefined>;
  /** Set a project source's module; undefined where the project reads no live source by that id. */
  setReferenceModule: (
    projectId: string,
    sourceId: string,
    moduleId: string | null,
  ) => Promise<{ previous: string | null; title: string } | undefined>;
}

const slot = portSlot<LabelPorts>('labels', 'provideLabelPorts');
export const provideLabelPorts = slot.provide;
const { port } = slot;

export const listFeedbackAs = port('listFeedbackAs');
export const setRequirementModuleOf = port('setRequirementModule');
export const setReferenceModuleOf = port('setReferenceModule');
