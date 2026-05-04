'use client';

import { useMarkAsRead } from '@/features/notification/hooks/use-notifications';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { pmApi } from '../api/pm-api';
import type { PmEscalation } from '../hooks/use-pm-escalations';

interface Props {
  projectId: string;
  escalation: PmEscalation;
  onClose: () => void;
}

export function PmEscalationModal({ projectId, escalation, onClose }: Props) {
  const [comment, setComment] = useState('');
  const [submittingOption, setSubmittingOption] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const markRead = useMarkAsRead();

  async function handleRespond(optionId: string) {
    setSubmittingOption(optionId);
    setError(null);
    try {
      await pmApi.respondToEscalation(projectId, escalation.decisionId, {
        optionId,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      markRead.mutate(escalation.notificationId);
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['notifications-unread'] });
      qc.invalidateQueries({ queryKey: ['pm', 'decisions', projectId] });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to respond');
      setSubmittingOption(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-lg space-y-4 rounded-lg border border-outline-variant/30 bg-surface p-5 shadow-xl">
        <header className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-warning">
              PM escalation · {escalation.severity}
            </p>
            <h2 className="mt-1 text-lg font-semibold text-on-surface">
              {escalation.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-outline hover:text-on-surface"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <p className="text-sm text-on-surface-variant">{escalation.question}</p>

        <div>
          <label className="text-xs uppercase tracking-wider text-on-surface-variant">
            Optional comment
          </label>
          <textarea
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="mt-1 w-full rounded border border-outline-variant bg-surface-container-low px-3 py-2 text-sm text-on-surface"
          />
        </div>

        {error && <p className="text-xs text-error">{error}</p>}

        <div className="flex flex-wrap justify-end gap-2">
          {escalation.options.map((opt) => (
            <button
              key={opt.id}
              type="button"
              disabled={submittingOption !== null}
              onClick={() => handleRespond(opt.id)}
              className="rounded border border-outline-variant bg-primary px-3 py-1.5 text-sm font-semibold text-on-primary disabled:opacity-50"
            >
              {submittingOption === opt.id ? 'Sending…' : opt.label}
            </button>
          ))}
        </div>

        {escalation.expiresAt && (
          <p className="text-[10px] text-outline">
            Expires {new Date(escalation.expiresAt).toLocaleString()}
          </p>
        )}
      </div>
    </div>
  );
}
