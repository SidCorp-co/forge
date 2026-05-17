'use client';

import { useEffect, useState } from 'react';
import { Button, Checkbox, Input, Modal, Select, Textarea } from '@/components/ui';
import type { IssuePriority } from '@/features/issue/types';
import { useDecomposeIssue } from '@/features/issue/hooks/use-issue-dependencies';
import { ApiError } from '@/lib/api/client';

interface DecomposeModalProps {
  open: boolean;
  onClose: () => void;
  issueId: string;
  displayId: string;
}

interface ChildDraft {
  title: string;
  description: string;
  priority: IssuePriority | '';
  category: string;
}

const MAX_CHILDREN = 8;
const PRIORITIES: ReadonlyArray<{ value: IssuePriority | ''; label: string }> = [
  { value: '', label: 'Inherit from parent' },
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'none', label: 'None' },
];

function emptyChild(): ChildDraft {
  return { title: '', description: '', priority: '', category: '' };
}

export function DecomposeModal({ open, onClose, issueId, displayId }: DecomposeModalProps) {
  const [children, setChildren] = useState<ChildDraft[]>([emptyChild()]);
  const [useIntegrationBranch, setUseIntegrationBranch] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [validation, setValidation] = useState<string[]>([]);

  const mutate = useDecomposeIssue(issueId);

  useEffect(() => {
    if (!open) {
      setChildren([emptyChild()]);
      setUseIntegrationBranch(true);
      setErrorMsg(null);
      setValidation([]);
    }
  }, [open]);

  function updateChild(idx: number, patch: Partial<ChildDraft>) {
    setChildren((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  }

  function addChild() {
    setChildren((prev) => (prev.length >= MAX_CHILDREN ? prev : [...prev, emptyChild()]));
  }

  function removeChild(idx: number) {
    setChildren((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== idx)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    const next = children.map((c) => (c.title.trim().length === 0 ? 'Title is required' : ''));
    setValidation(next);
    if (next.some((m) => m.length > 0)) return;

    try {
      await mutate.mutateAsync({
        children: children.map((c) => ({
          title: c.title.trim(),
          description: c.description.trim().length > 0 ? c.description.trim() : undefined,
          priority: c.priority === '' ? undefined : c.priority,
          category: c.category.trim().length > 0 ? c.category.trim() : undefined,
        })),
        useIntegrationBranch,
      });
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'INTEGRATION_BRANCH_CONFLICT') {
          setErrorMsg(
            'Could not find an unused integration branch name. Rename the parent or pick a different slug.',
          );
          return;
        }
        if (err.code === 'GIT_PUSH_FAILED') {
          setErrorMsg(
            'Git push to the project remote failed. Check the remote configuration and push credentials.',
          );
          return;
        }
        if (err.code === 'GIT_FETCH_FAILED') {
          setErrorMsg('Git fetch from the project remote failed. Check the remote configuration.');
          return;
        }
        if (err.code === 'BAD_REQUEST') {
          setErrorMsg(err.message || 'Invalid request.');
          return;
        }
      }
      setErrorMsg(err instanceof Error ? err.message : 'Failed to decompose this issue.');
    }
  }

  return (
    <Modal open={open} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <header className="border-b border-outline-variant/20 bg-surface-container px-4 py-3">
          <h2 className="text-sm font-semibold text-on-surface">
            Decompose {displayId} into sub-issues
          </h2>
          <p className="mt-1 text-xs text-on-surface-variant">
            Create N children at once. Children land on hold and cascade-approve once the
            parent moves <code>waiting → approved</code>.
          </p>
        </header>

        <div className="space-y-4 px-4 py-4">
          {children.map((child, idx) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable within session
            <div
              key={idx}
              className="rounded-sm border border-outline-variant/30 bg-surface-container-low p-3"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
                  Child {idx + 1}
                </span>
                {children.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => removeChild(idx)}
                    className="text-xs text-on-surface-variant hover:text-error"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              <Input
                placeholder="Title"
                value={child.title}
                onChange={(e) => updateChild(idx, { title: e.target.value })}
                aria-label={`Child ${idx + 1} title`}
              />
              {validation[idx] ? (
                <p className="mt-1 text-xs text-error">{validation[idx]}</p>
              ) : null}
              <Textarea
                className="mt-2"
                placeholder="Description (optional)"
                rows={2}
                value={child.description}
                onChange={(e) => updateChild(idx, { description: e.target.value })}
                aria-label={`Child ${idx + 1} description`}
              />
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Select
                  value={child.priority}
                  onChange={(e) =>
                    updateChild(idx, {
                      priority: (e.target.value as IssuePriority | '') || '',
                    })
                  }
                  aria-label={`Child ${idx + 1} priority`}
                >
                  {PRIORITIES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </Select>
                <Input
                  placeholder="Category (optional)"
                  value={child.category}
                  onChange={(e) => updateChild(idx, { category: e.target.value })}
                  aria-label={`Child ${idx + 1} category`}
                />
              </div>
            </div>
          ))}
          {children.length < MAX_CHILDREN ? (
            <Button type="button" variant="ghost" onClick={addChild}>
              Add another child
            </Button>
          ) : (
            <p className="text-xs text-on-surface-variant">
              Maximum of {MAX_CHILDREN} children per decomposition.
            </p>
          )}

          <label className="flex items-start gap-2 rounded-sm border border-outline-variant/30 bg-surface-container-low p-3">
            <Checkbox
              checked={useIntegrationBranch}
              onChange={(e) => setUseIntegrationBranch(e.target.checked)}
            />
            <div className="text-xs">
              <div className="font-semibold text-on-surface">Create shared integration branch</div>
              <p className="mt-1 text-on-surface-variant">
                Children branch off a parent-owned integration branch and merge back to it. The
                parent owns the final merge into the project default branch. Uncheck to have each
                child branch off the project default directly.
              </p>
            </div>
          </label>

          {errorMsg ? (
            <div
              role="alert"
              className="rounded-sm border border-error/30 bg-error-container/30 px-3 py-2 text-xs text-on-error-container"
            >
              {errorMsg}
            </div>
          ) : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-outline-variant/20 bg-surface-container px-4 py-3">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={mutate.isPending}>
            {mutate.isPending ? 'Decomposing…' : 'Decompose'}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
