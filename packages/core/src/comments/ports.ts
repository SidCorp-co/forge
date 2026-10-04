// What entity comments need from the design context they comment on: the requirement, feedback
// and workflow rows a thread hangs off. The composition root provides them at boot.

import type { NodeRef } from '@forge/contracts/workflow-health';
import type { Tx } from '../db/client.js';
import type { Refusal } from '../lib/refusal.js';

export interface CommentPorts {
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

let provided: CommentPorts | null = null;

export function provideCommentPorts(given: CommentPorts): void {
  provided = given;
}

function commentPorts(): CommentPorts {
  if (!provided) {
    throw new Error(
      'comments: no ports were provided; the process entry calls provideCommentPorts before it serves',
    );
  }
  return provided;
}

export const requirementRowIn: CommentPorts['requirementRowIn'] = (tx, projectId, ref) =>
  commentPorts().requirementRowIn(tx, projectId, ref);
export const feedbackRowIn: CommentPorts['feedbackRowIn'] = (tx, projectId, ref) =>
  commentPorts().feedbackRowIn(tx, projectId, ref);
export const designNodeRefusal: CommentPorts['designNodeRefusal'] = (
  tx,
  projectId,
  workflowRef,
  node,
  base,
) => commentPorts().designNodeRefusal(tx, projectId, workflowRef, node, base);
