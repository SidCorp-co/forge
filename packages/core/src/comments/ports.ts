// What entity comments need from the design context they comment on: the requirement, feedback
// and workflow rows a thread hangs off. The composition root provides them at boot.

import type { NodeRef } from '@forge/contracts/workflow-health';
import type { Tx } from '../db/client.js';
import { portSlot } from '../lib/port-slot.js';
import type { Refusal } from '../lib/refusal.js';

interface CommentPorts {
  requirementRowIn: (
    tx: Tx,
    projectId: string,
    ref: string,
  ) => Promise<{ id: string; reqSeq: number; title: string }>;
  feedbackRowIn: (
    tx: Tx,
    projectId: string,
    ref: string,
  ) => Promise<{ id: string; fbSeq: number; title: string }>;
  /** Why `node` is not a node of the workflow's latest design revision; null when it is, or when there is no design. */
  designNodeRefusal: (
    tx: Tx,
    projectId: string,
    workflowRef: string,
    node: NodeRef,
    base: string,
  ) => Promise<Refusal | null>;
}

const slot = portSlot<CommentPorts>('comments', 'provideCommentPorts');
export const provideCommentPorts = slot.provide;
const { port } = slot;

export const requirementRowIn = port('requirementRowIn');
export const feedbackRowIn = port('feedbackRowIn');
export const designNodeRefusal = port('designNodeRefusal');
