'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { useCreateIssue } from '@/features/issue/hooks/use-issues';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import { formatApiError } from '@/lib/api/error';
import { Save, X } from 'lucide-react';

type IssuePriority = 'none' | 'low' | 'medium' | 'high' | 'critical';

/**
 * Phase 2.6-F2: core's create-issue schema (see `issueCreateSchema` in
 * `packages/core/src/issues/routes.ts`) accepts `{ title, description?,
 * priority?, category?, assigneeId?, parentIssueId?, labels? }`. The legacy
 * form had acceptance-criteria + suggested-solution + attachments fields
 * that no longer map; they're omitted here and will return in a follow-up
 * if the core schema grows them back.
 */
export default function NewIssuePage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const project = useProjectBySlug(slug);
  const createIssue = useCreateIssue(project?.id);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<IssuePriority>('medium');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project) return;
    if (!title.trim()) {
      setError('Title is required.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await createIssue.mutateAsync({
        title,
        ...(description.trim() ? { description } : {}),
        priority,
      });
      router.push(`/projects/${slug}/issues`);
    } catch (err) {
      setError(formatApiError(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-8 antialiased">
      <div className="mb-8 border-b border-outline-variant/30 pb-4">
        <h2 className="text-[14px] font-bold uppercase tracking-[0.2em] text-primary">
          Create new issue
        </h2>
      </div>

      {error && (
        <div className="mb-8">
          <AlertBanner variant="error">{error}</AlertBanner>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-8">
        <div className="space-y-6 rounded-sm border border-outline-variant/30 bg-surface p-6 shadow-xl">
          <div>
            <label
              htmlFor="title"
              className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant"
            >
              Title <span className="text-danger">*</span>
            </label>
            <input
              id="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              className="w-full rounded-sm border border-outline-variant/50 bg-surface-container-low px-4 py-3 text-sm text-on-surface shadow-sm transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div>
            <label
              htmlFor="description"
              className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant"
            >
              Description
            </label>
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={6}
              className="w-full rounded-sm border border-outline-variant/50 bg-surface-container-low px-4 py-3 text-sm text-on-surface shadow-sm transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div className="w-full sm:w-1/2">
            <label
              htmlFor="priority"
              className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant"
            >
              Priority
            </label>
            <select
              id="priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as IssuePriority)}
              className="w-full rounded-sm border border-outline-variant/50 bg-surface-container-low px-4 py-3 text-sm font-medium text-on-surface shadow-sm transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="none">UNASSIGNED</option>
              <option value="low">LOW</option>
              <option value="medium">MEDIUM</option>
              <option value="high">HIGH</option>
              <option value="critical">CRITICAL</option>
            </select>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-outline-variant/30 pt-4 sm:flex-row">
          <button
            type="submit"
            disabled={submitting || !project}
            className="flex items-center justify-center gap-2 rounded-sm bg-primary px-8 py-3 text-[10px] font-bold uppercase tracking-[0.2em] text-on-primary shadow-lg transition-all hover:bg-on-surface-variant active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100"
          >
            {submitting ? 'SAVING…' : (
              <>
                <Save className="h-4 w-4" /> CREATE
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => router.back()}
            className="flex items-center justify-center gap-2 rounded-sm border border-outline-variant/30 bg-surface-container-low px-8 py-3 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant transition-all hover:bg-surface-container-high hover:text-on-surface"
          >
            <X className="h-4 w-4" /> CANCEL
          </button>
        </div>
      </form>
    </div>
  );
}
