// A workflow's Decisions view: the decisions made on it, then the questions people raised on it. A
// workflow has no comment thread of its own, so a question raised there (through the old Questions desk
// or any door sending intent question) is read here, never on a page of its own (REQ-33 BC-8).

import { Decisions, RaisedQuestions } from "@/features/comments";

export function WorkflowDecisions({ projectId, workflowId }: { projectId: string; workflowId: string }) {
  return (
    <div className="grid gap-8">
      <Decisions projectId={projectId} scope="workflow" targetRef={workflowId} />
      <RaisedQuestions projectId={projectId} scope="workflow" targetRef={workflowId} />
    </div>
  );
}
