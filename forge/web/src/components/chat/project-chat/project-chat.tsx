'use client';

// Phase 2.6-F2: project chat depends on /agent-sessions endpoints that have
// no direct core equivalent. The viewer has been removed from layout.tsx;
// this stub remains so legacy imports resolve.

interface ProjectChatProps {
  projectSlug: string;
  activeIssueId?: string;
  onClose: () => void;
}

export function ProjectChat({ projectSlug: _p, activeIssueId: _a, onClose: _c }: ProjectChatProps) {
  return null;
}
