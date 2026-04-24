'use client';

// Phase 2.6-F2: the modal is replaced by the dedicated
// `/projects/[slug]/issues/[id]` page. Component remains for legacy imports.

interface IssueDetailModalProps {
  issueId: string;
  onClose: () => void;
}

export function IssueDetailModal({ issueId: _issueId, onClose }: IssueDetailModalProps) {
  void onClose;
  return null;
}
