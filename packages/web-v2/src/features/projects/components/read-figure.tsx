// A health-rollup figure, or the pending or failed mark `badge-read.ts` gives every badge.

import type { ReactNode } from 'react';
import { badgeFace, type QueryRead } from '@/design/patterns/badge-read';

export interface ReadFigureProps {
  value: number | null;
  /** A null figure under a `read` read is a defect upstream and draws as failed. */
  read: QueryRead;
  counts?: string;
  /** What the figure is where it is not a count ("the project's health"). */
  subject?: string;
  children?: (value: number) => ReactNode;
}

function nameOf(state: 'pending' | 'failed', counts?: string, subject?: string): string {
  if (subject) return state === 'failed' ? `${subject} could not be read` : `reading ${subject}`;
  return badgeFace({ badgeRead: state, badgeCounts: counts })?.phrase ?? '';
}

export function ReadFigure({ value, read, counts, subject, children }: ReadFigureProps) {
  if (value !== null && read === 'read') return <>{children ? children(value) : value}</>;
  const state = read === 'pending' ? 'pending' : 'failed';
  const name = nameOf(state, counts, subject);
  return (
    <span role="img" aria-label={name} title={name}>
      {state === 'failed' ? '!' : '…'}
    </span>
  );
}
