'use client';

import { useState } from 'react';
import { Check, Copy, GitBranch, Link2, Pencil, RotateCcw } from 'lucide-react';
import { agentApi } from '@/features/agent/api';
import type { ChatMessageData } from './chat-message-types';

interface TurnActionsProps {
  message: ChatMessageData;
  sessionId: string | null;
  onAfterEdit?: () => void;
  onAfterRegenerate?: () => void;
  onAfterFork?: (newSessionDocumentId: string) => void;
}

/**
 * Hover action bar shown on each chat message. Visibility is driven by
 * `group-hover` on the parent message wrapper. Buttons are role-aware:
 * Copy (always), Edit (user only), Regenerate (assistant only), Permalink and
 * Fork from here (when `turnId` is set).
 */
export function TurnActions({
  message,
  sessionId,
  onAfterEdit,
  onAfterRegenerate,
  onAfterFork,
}: TurnActionsProps) {
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const turnId = message.turnId ?? null;

  function copyText() {
    navigator.clipboard.writeText(message.content).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function copyPermalink() {
    if (!turnId || !sessionId) return;
    const url = `${window.location.origin}${window.location.pathname}?session=${sessionId}&turn=${turnId}`;
    navigator.clipboard.writeText(url).catch(() => {});
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }

  function startEdit() {
    setDraft(message.content);
    setEditing(true);
    setError(null);
  }

  async function commitEdit() {
    if (!turnId || !sessionId) return;
    if (draft.trim() === message.content.trim()) {
      setEditing(false);
      return;
    }
    setPending(true);
    setError(null);
    try {
      // Send back the editedAt we loaded so the server rejects with 409 if a
      // concurrent editor has touched this turn since.
      await agentApi.editTurn(sessionId, turnId, {
        content: draft,
        ...(message.turnEditedAt !== undefined && message.turnEditedAt !== null
          ? { expectedEditedAt: message.turnEditedAt }
          : {}),
      });
      setEditing(false);
      onAfterEdit?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save edit');
    } finally {
      setPending(false);
    }
  }

  async function regenerate() {
    if (!turnId || !sessionId) return;
    const ok = window.confirm(
      'Regenerating will discard the replies after this message. Continue?',
    );
    if (!ok) return;
    setPending(true);
    setError(null);
    try {
      await agentApi.regenerateTurn(sessionId, turnId);
      onAfterRegenerate?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to regenerate');
    } finally {
      setPending(false);
    }
  }

  async function forkHere() {
    if (!turnId || !sessionId) return;
    setPending(true);
    setError(null);
    try {
      const res = await agentApi.forkSession(sessionId, turnId);
      onAfterFork?.(res.documentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fork');
    } finally {
      setPending(false);
    }
  }

  if (editing) {
    return (
      <div className="mt-2 space-y-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="w-full rounded border border-outline-variant bg-surface-container-low p-2 text-sm font-sans"
          rows={Math.min(10, Math.max(2, draft.split('\n').length))}
          aria-label="Edit message"
          disabled={pending}
        />
        <div className="flex items-center gap-2">
          <button
            onClick={commitEdit}
            disabled={pending}
            className="rounded bg-primary px-2 py-1 text-xs text-on-primary disabled:opacity-50"
          >
            {pending ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={() => setEditing(false)}
            disabled={pending}
            className="rounded border border-outline-variant px-2 py-1 text-xs"
          >
            Cancel
          </button>
          {error && <span className="text-xs text-error">{error}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      <button
        onClick={copyText}
        title="Copy"
        aria-label="Copy message"
        className="rounded p-1.5 text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
      >
        {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
      </button>
      {message.role === 'user' && (
        <button
          onClick={startEdit}
          title="Edit"
          aria-label="Edit message"
          disabled={!turnId}
          className="rounded p-1.5 text-on-surface-variant hover:bg-surface-container hover:text-on-surface disabled:opacity-30"
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
      {message.role === 'assistant' && (
        <button
          onClick={regenerate}
          title="Regenerate"
          aria-label="Regenerate response"
          disabled={!turnId || pending}
          className="rounded p-1.5 text-on-surface-variant hover:bg-surface-container hover:text-on-surface disabled:opacity-30"
        >
          <RotateCcw className="h-3 w-3" />
        </button>
      )}
      {turnId && (
        <button
          onClick={copyPermalink}
          title="Copy permalink"
          aria-label="Permalink to this message"
          className="rounded p-1.5 text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
        >
          {linkCopied ? <Check className="h-3 w-3 text-success" /> : <Link2 className="h-3 w-3" />}
        </button>
      )}
      {turnId && onAfterFork && (
        <button
          onClick={forkHere}
          title="Fork from here"
          aria-label="Fork session from here"
          disabled={pending}
          className="rounded p-1.5 text-on-surface-variant hover:bg-surface-container hover:text-on-surface disabled:opacity-30"
        >
          <GitBranch className="h-3 w-3" />
        </button>
      )}
      {error && <span className="ml-1 text-xs text-error">{error}</span>}
    </div>
  );
}
