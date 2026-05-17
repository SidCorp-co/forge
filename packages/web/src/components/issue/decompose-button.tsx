'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';
import { useIssueDependencies } from '@/features/issue/hooks/use-issue-dependencies';
import { DecomposeModal } from './decompose-modal';

interface DecomposeButtonProps {
  issueId: string;
  displayId: string;
  status: string;
}

const ELIGIBLE_STATUSES = new Set(['confirmed', 'waiting']);

/**
 * ISS-138 (PR-D) — surfaces a `Decompose…` action for parent epics. Hidden
 * unless the issue is in `confirmed` or `waiting` AND has no existing
 * outgoing `decomposes` edges (so the human flow always lands on the first
 * decomposition; subsequent children get added through the relations modal
 * once the integration branch exists).
 */
export function DecomposeButton({ issueId, displayId, status }: DecomposeButtonProps) {
  const [open, setOpen] = useState(false);
  const deps = useIssueDependencies(issueId);

  if (!ELIGIBLE_STATUSES.has(status)) return null;
  if (deps.isLoading) return null;

  const hasDecomposes = (deps.data?.outgoing ?? []).some((e) => e.kind === 'decomposes');
  if (hasDecomposes) return null;

  return (
    <>
      <Button variant="secondary" size="xs" onClick={() => setOpen(true)}>
        Decompose…
      </Button>
      <DecomposeModal
        open={open}
        onClose={() => setOpen(false)}
        issueId={issueId}
        displayId={displayId}
      />
    </>
  );
}
