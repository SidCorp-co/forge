import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Issue, IssueStatus } from "@/lib/types";
import { updateIssue } from "@/lib/api";
import { Modal } from "../ui/modal";
import { IssueHeader } from "./issue-header";
import { IssueFields } from "./issue-fields";
import { IssueAgentSessions } from "./issue-agent-sessions";
import { IssueAttachments } from "./issue-attachments";
import { IssueEnrichment } from "./issue-enrichment";
import { IssueTasks } from "./issue-tasks";
import { IssueHistory } from "./issue-history";
import { IssueComments } from "./issue-comments";
import { IssueRelations } from "./issue-relations";
import { IssueCostSummary } from "./issue-cost-summary";

interface Props {
  issue: Issue;
  onClose: () => void;
  onUpdated: () => void;
}

export function IssueDetail({ issue, onClose, onUpdated }: Props) {
  const navigate = useNavigate();
  const { slug } = useParams<{ slug: string }>();
  const [updating, setUpdating] = useState(false);

  async function handleUpdate(id: string, data: Partial<Issue>) {
    setUpdating(true);
    try {
      await updateIssue(id, data);
      onUpdated();
    } finally {
      setUpdating(false);
    }
  }

  async function handleStatusChange(newStatus: IssueStatus) {
    if (newStatus === issue.status) return;
    handleUpdate(issue.documentId, { status: newStatus });
  }

  return (
    <Modal open onClose={onClose}>
      <div data-paste-zone className="divide-y divide-gray-100">
        <IssueHeader issue={issue} onClose={onClose} onUpdate={handleUpdate} />
        <IssueFields issue={issue} onUpdate={handleUpdate} />
        <IssueAgentSessions issue={issue} slug={slug!} onClose={onClose} navigate={navigate} />
        <IssueCostSummary documentId={issue.documentId} />
        <IssueAttachments issue={issue} onUpdated={onUpdated} />
        <IssueEnrichment issue={issue} />
        <IssueTasks issue={issue} />
        <IssueRelations issue={issue} />
        <IssueHistory issue={issue} />
        <IssueComments issueDocumentId={issue.documentId} initialComments={issue.comments ?? []} />
      </div>
    </Modal>
  );
}
