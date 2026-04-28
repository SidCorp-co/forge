'use client';

// Phase 2.6-F2: core has no upload endpoint yet. Attachment UI is suppressed
// so the issue-detail page renders without a broken uploader.

interface IssueAttachmentsProps {
  attachments?: unknown[];
  issueDocumentId?: string;
  onUpdate?: (id: string, data: unknown) => void;
}

export function IssueAttachments(_props: IssueAttachmentsProps) {
  return null;
}

export default IssueAttachments;
