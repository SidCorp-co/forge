'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Input } from '@/components/ui';
import { ApiError } from '@/lib/api/client';
import { formatApiError } from '@/lib/api/error';
import {
  getIssueBranchOverride,
  useResolvedBranchConfig,
  type BranchConfigOverride,
} from '@/features/issue/hooks/use-resolved-branch-config';
import type { Issue, IssuePatchInput } from '@forge/contracts';

interface BranchConfigCardProps {
  issue: Issue;
  projectSlug: string;
  onPatch: (issueId: string, patch: IssuePatchInput) => void | Promise<void>;
}

type DraftFields = { baseBranch: string; targetBranch: string; prodBranch: string };

function overrideToDraft(o: BranchConfigOverride | null): DraftFields {
  return {
    baseBranch: o?.baseBranch ?? '',
    targetBranch: o?.targetBranch ?? '',
    prodBranch: o?.prodBranch ?? '',
  };
}

function mapErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.code === 'BRANCH_SELF_REFERENCE') {
    return "Base branch must not reference this issue's own branch.";
  }
  return formatApiError(err);
}

export function BranchConfigCard({ issue, projectSlug, onPatch }: BranchConfigCardProps) {
  const resolved = useResolvedBranchConfig(issue, projectSlug);
  const initialOverride = getIssueBranchOverride(issue);
  const hasOverride = initialOverride !== null;

  const [expanded, setExpanded] = useState(false);
  const [isOverride, setIsOverride] = useState(hasOverride);
  const [draft, setDraft] = useState<DraftFields>(() => overrideToDraft(initialOverride));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync when the issue is mutated elsewhere (React Query invalidation).
  useEffect(() => {
    setIsOverride(hasOverride);
    setDraft(overrideToDraft(initialOverride));
    setError(null);
    // initialOverride is read from issue.metadata; depend on issue identity
    // so a stale closure doesn't strand local draft against newer server state.
  }, [issue.id, issue.updatedAt, hasOverride, initialOverride]);

  // TODO(ISS-137 follow-up): soft warn when a branch is missing on remote.

  const dirty = useMemo(() => {
    if (isOverride !== hasOverride) return true;
    if (!isOverride) return false;
    const current = overrideToDraft(initialOverride);
    return (
      current.baseBranch !== draft.baseBranch ||
      current.targetBranch !== draft.targetBranch ||
      current.prodBranch !== draft.prodBranch
    );
  }, [isOverride, hasOverride, initialOverride, draft]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      let next: BranchConfigOverride | null = null;
      if (isOverride) {
        const candidate: BranchConfigOverride = {
          baseBranch: draft.baseBranch.trim() || null,
          targetBranch: draft.targetBranch.trim() || null,
          prodBranch: draft.prodBranch.trim() || null,
        };
        const allCleared =
          !candidate.baseBranch && !candidate.targetBranch && !candidate.prodBranch;
        next = allCleared ? null : candidate;
      }
      await onPatch(issue.id, { metadata: { branchConfig: next } });
    } catch (err) {
      setError(mapErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setIsOverride(hasOverride);
    setDraft(overrideToDraft(initialOverride));
    setError(null);
  };

  const summaryBadge = hasOverride ? 'override' : 'from project';

  return (
    <section className="rounded-sm border border-outline-variant/20 bg-surface">
      <button
        type="button"
        className="flex w-full items-center justify-between border-b border-outline-variant/20 bg-surface-container-low px-4 py-2 text-left"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          Branch config
        </h3>
        <span className="text-[10px] text-on-surface-variant">{expanded ? '−' : '+'}</span>
      </button>
      {!expanded && (
        <div className="px-4 py-2 text-xs text-on-surface-variant">
          <span className="font-mono">base: {resolved.baseBranch}</span>
          <span className="mx-2 text-outline">·</span>
          <span className="font-mono">prod: {resolved.prodBranch}</span>
          <span className="ml-2 inline-flex items-center rounded-sm border border-outline-variant/30 bg-surface-container-high px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest">
            {summaryBadge}
          </span>
        </div>
      )}
      {expanded && (
        <div className="space-y-3 p-4 text-sm">
          <Checkbox
            id="branch-config-override-toggle"
            label="Override project branch config"
            checked={isOverride}
            onChange={(e) => {
              const next = e.target.checked;
              setIsOverride(next);
              if (!next) setError(null);
            }}
          />
          {isOverride ? (
            <>
              <BranchInputRow
                label="Base branch"
                value={draft.baseBranch}
                placeholder={resolved.baseBranch}
                onChange={(v) => setDraft((d) => ({ ...d, baseBranch: v }))}
              />
              <BranchInputRow
                label="Target branch"
                value={draft.targetBranch}
                placeholder={resolved.targetBranch}
                onChange={(v) => setDraft((d) => ({ ...d, targetBranch: v }))}
              />
              <BranchInputRow
                label="Prod branch"
                value={draft.prodBranch}
                placeholder={resolved.prodBranch}
                onChange={(v) => setDraft((d) => ({ ...d, prodBranch: v }))}
              />
              <p className="text-[10px] text-outline">
                Leave a field blank to fall back to the project default.
              </p>
            </>
          ) : (
            <>
              <ReadonlyRow label="Base branch" value={resolved.baseBranch} />
              <ReadonlyRow label="Target branch" value={resolved.targetBranch} />
              <ReadonlyRow label="Prod branch" value={resolved.prodBranch} />
            </>
          )}
          {error && (
            <p
              role="alert"
              className="text-[10px] uppercase tracking-widest text-error"
            >
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button size="xs" variant="ghost" onClick={handleCancel} disabled={saving || !dirty}>
              Cancel
            </Button>
            <Button size="xs" onClick={handleSave} disabled={saving || !dirty}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function ReadonlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
        {label}
      </span>
      <div className="flex items-center gap-2 min-w-0">
        <span className="truncate font-mono text-xs">{value}</span>
        <span className="inline-flex items-center rounded-sm border border-outline-variant/30 bg-surface-container-high px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest">
          from project
        </span>
      </div>
    </div>
  );
}

function BranchInputRow({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
        {label}
      </label>
      <Input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
      />
    </div>
  );
}
