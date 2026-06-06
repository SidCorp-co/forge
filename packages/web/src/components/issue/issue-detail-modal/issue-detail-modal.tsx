'use client';

import { useCallback, useEffect, useState } from 'react';
import { Modal, Skeleton, Button, ToastContainer } from '@/components/ui';
import {
  useIssue,
  usePatchIssue,
  useTransitionIssue,
} from '@/features/issue/hooks/use-issues';
import { useProjectMembers } from '@/features/project/hooks/use-project-members';
import { useMeProfile } from '@/features/me/hooks/use-me';
import { useToast } from '@/hooks/use-toast';
import { formatApiError } from '@/lib/api/error';
import { IssueDetailBody } from '@/components/issue/issue-detail-body';
import { IssueQuickBar } from '@/components/issue/issue-detail-modal/issue-quick-bar';
import { STATUS_TAB_MAP } from '@/components/issue/issue-detail-header';
import { type IssueDetailTabKey } from '@/components/issue/issue-detail-tabs';
import type { IssuePatchInput } from '@forge/contracts';
import type { IssueStatus } from '@/features/issue/types';

interface IssueDetailModalProps {
  open: boolean;
  issueId: string | null;
  projectSlug: string;
  onClose: () => void;
}

/**
 * Quick-preview modal — renders the full issue body inline. Modal handles
 * Esc + click-outside + focus trap; the "Open full" link navigates to the
 * dedicated detail page when the operator wants the agent-drawer split.
 */
export function IssueDetailModal({ open, issueId, projectSlug, onClose }: IssueDetailModalProps) {
  const { data: issue, isLoading, error } = useIssue(open && issueId ? issueId : undefined);
  const { data: members = [] } = useProjectMembers(issue?.projectId);
  const { data: meProfile } = useMeProfile();
  const patchIssue = usePatchIssue();
  const transitionIssue = useTransitionIssue();
  const { toasts, addToast } = useToast();

  const [tab, setTab] = useState<IssueDetailTabKey>('overview');
  const [sessionId, setSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (open && issue) setTab(STATUS_TAB_MAP[issue.status as IssueStatus]);
  }, [open, issue?.id]);

  const handleStatusUpdate = useCallback(
    (issueIdValue: string, data: { status: IssueStatus }) => {
      if (issue && data.status === issue.status) return;
      transitionIssue.mutate({ id: issueIdValue, toStatus: data.status });
    },
    [issue, transitionIssue],
  );

  const handlePatch = useCallback(
    (issueIdValue: string, patch: IssuePatchInput) => {
      patchIssue.mutate(
        { id: issueIdValue, patch },
        {
          onSuccess: () => {
            if (Object.prototype.hasOwnProperty.call(patch, 'assigneeId')) {
              addToast('Assignee updated');
            }
          },
        },
      );
    },
    [patchIssue, addToast],
  );

  return (
    <Modal open={open} onClose={onClose}>
      <div className="px-5 py-4 sm:px-6">
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : error ? (
          <p className="text-[10px] uppercase tracking-widest text-error">
            {formatApiError(error)}
          </p>
        ) : !issue ? (
          <p className="text-[11px] text-outline">Issue not found.</p>
        ) : (
          <>
            <IssueQuickBar
              issue={issue}
              members={members}
              projectSlug={projectSlug}
              onStatusUpdate={handleStatusUpdate}
              onPatch={handlePatch}
              onClose={onClose}
            />
            <div className="max-h-[75vh] overflow-y-auto">
              <IssueDetailBody
                issue={issue}
                projectSlug={projectSlug}
                members={members}
                meProfile={meProfile ?? null}
                isProjectOwner={false}
                activeTab={tab}
                onTabChange={setTab}
                selectedSessionId={sessionId}
                onSelectSession={setSessionId}
                onPatch={handlePatch}
                onStatusUpdate={handleStatusUpdate}
              />
            </div>

            <footer className="mt-4 flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={onClose} size="xs">
                Close
              </Button>
            </footer>
          </>
        )}
      </div>
      <ToastContainer toasts={toasts} />
    </Modal>
  );
}
