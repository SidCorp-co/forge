/** The target an item is about, as a reader names it: by key, never by uuid. */

import type { FeedbackTargetView } from '@forge/contracts/feedback';
import type { NodeRef } from '@forge/contracts/workflow-health';
import type { Linked } from './list-read.js';
import type { Row } from './read.js';
import { targetTypeOf } from './refs.js';

export function targetView(r: Row, l: Linked): FeedbackTargetView {
  const type = targetTypeOf(r);
  if (type === 'requirement') {
    const q = l.requirements.get(r.requirementId as string);
    return { type, key: q?.key ?? (r.requirementId as string), title: q?.title ?? null };
  }
  if (type === 'issue') {
    const i = l.issues.get(r.issueId as string);
    return { type, key: i?.key ?? (r.issueId as string), title: i?.title ?? null };
  }
  if (type === 'release') {
    return {
      type,
      key: l.releases.get(r.releaseRunId as string) ?? (r.releaseRunId as string),
      title: null,
    };
  }
  if (type === 'workflow') {
    const w = l.workflows.get(r.workflowId as string);
    const node: NodeRef | null = r.stepId
      ? { step: r.stepId }
      : r.edgeFrom && r.edgeTo
        ? {
            edge: {
              from: r.edgeFrom,
              to: r.edgeTo,
              ...(r.edgeLabel ? { label: r.edgeLabel } : {}),
            },
          }
        : null;
    return {
      type,
      key: w?.flow ?? (r.workflowId as string),
      title: w?.title ?? null,
      ...(node ? { node } : {}),
    };
  }
  if (type === 'contract') {
    const provider = l.providers.get(r.contractProviderProjectId as string);
    return { type, key: `${provider}/${r.contractSlug}@${r.contractVersion}`, title: null };
  }
  if (type === 'endpoint') {
    return {
      type,
      key: `${r.endpointContractSlug}:${r.endpointElement}`,
      title: `${r.endpointContractSlug} ${r.endpointContractVersion}`,
    };
  }
  return { type, key: r.whereSeen ?? '', title: null };
}
