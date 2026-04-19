'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCreateIssue } from '@/features/issue/hooks/use-issues';
import { useState } from 'react';
import { issueApi } from '@/features/issue/api/issue-api';
import { useProject } from '@/features/project/hooks/use-projects';
import { AlertBanner } from '@/components/ui/alert-banner';
import { FileUpload, type UploadedFile } from '@/components/ui/file-upload';
import type { IssuePriority } from '@/features/issue/types';
import { Save, X } from 'lucide-react';

export default function NewIssuePage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const { data: projectData } = useProject(slug);
  const project = projectData?.data;
  const createIssue = useCreateIssue();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<IssuePriority>('medium');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('');
  const [suggestedSolution, setSuggestedSolution] = useState('');
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project || !title.trim()) return;

    setSubmitting(true);
    setError(null);
    try {
      await createIssue.mutateAsync({
        title,
        description,
        priority,
        project: project.documentId,
        ...(acceptanceCriteria.trim() ? { acceptanceCriteria } : {}),
        ...(suggestedSolution.trim() ? { suggestedSolution } : {}),
        ...(attachments.length > 0 ? { attachments: attachments.map((a) => a.id) } : {}),
      });
      router.push(`/projects/${slug}/issues`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create issue. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl py-8 px-4 sm:px-8 font-['Inter'] antialiased">
      <div className="mb-8 border-b border-outline-variant/30 pb-4">
        <h2 className="text-[14px] font-bold uppercase tracking-[0.2em] text-primary">Create New Issue</h2>
        <p className="text-[10px] uppercase font-mono tracking-widest text-outline mt-1">INITIALIZE TASK RECORD IN MAINFRAME</p>
      </div>

      {error && (
        <div className="mb-8">
          <AlertBanner variant="error">{error}</AlertBanner>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-8">
        <div className="bg-surface border border-outline-variant/30 p-6 rounded-sm space-y-6 shadow-xl">
          <div>
            <label htmlFor="title" className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
              Title <span className="text-danger">*</span>
            </label>
            <input
              id="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              className="w-full rounded-sm border border-outline-variant/50 bg-surface-container-low px-4 py-3 text-sm text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary transition-all shadow-sm"
              placeholder="E.g. Neural bridge latency spikes on Node 4"
            />
          </div>

          <div>
            <label htmlFor="description" className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
              Description
            </label>
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={6}
              className="w-full rounded-sm border border-outline-variant/50 bg-surface-container-low px-4 py-3 text-sm text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary transition-all shadow-sm"
              placeholder="Detailed description of the issue or requirement..."
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <label htmlFor="acceptanceCriteria" className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                Acceptance Criteria
              </label>
              <textarea
                id="acceptanceCriteria"
                value={acceptanceCriteria}
                onChange={(e) => setAcceptanceCriteria(e.target.value)}
                rows={4}
                className="w-full rounded-sm border border-outline-variant/50 bg-surface-container-low px-4 py-3 text-sm text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary transition-all shadow-sm"
                placeholder="What must be true to close this issue..."
              />
            </div>
            <div>
              <label htmlFor="suggestedSolution" className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                Suggested Solution
              </label>
              <textarea
                id="suggestedSolution"
                value={suggestedSolution}
                onChange={(e) => setSuggestedSolution(e.target.value)}
                rows={4}
                className="w-full rounded-sm border border-outline-variant/50 bg-surface-container-low px-4 py-3 text-sm text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary transition-all shadow-sm"
                placeholder="Technical approach or recommendation..."
              />
            </div>
          </div>

          <div className="w-full sm:w-1/2">
            <label htmlFor="priority" className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
              Priority Level
            </label>
            <select
              id="priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as IssuePriority)}
              className="w-full rounded-sm border border-outline-variant/50 bg-surface-container-low px-4 py-3 text-sm font-medium text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary transition-all shadow-sm"
            >
              <option value="none">UNASSIGNED</option>
              <option value="low">LOW</option>
              <option value="medium">MEDIUM</option>
              <option value="high">HIGH</option>
              <option value="critical">CRITICAL</option>
            </select>
          </div>

          <div className="pt-2 border-t border-outline-variant/30">
            <label className="mb-4 mt-4 block text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">System Artifacts</label>
            <div className="rounded-sm border border-outline-variant/30 bg-surface-container-low p-4">
              <FileUpload
                value={attachments}
                onChange={setAttachments}
                uploadFn={issueApi.uploadFile}
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 pt-4 border-t border-outline-variant/30">
          <button
            type="submit"
            disabled={submitting || !title.trim()}
            className="flex items-center justify-center gap-2 rounded-sm bg-primary px-8 py-3 text-[10px] font-bold uppercase tracking-[0.2em] text-on-primary hover:bg-on-surface-variant active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100 transition-all shadow-lg"
          >
            {submitting ? 'INITIALIZING...' : (
              <>
                <Save className="h-4 w-4" /> COMMIT RECORD
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => router.back()}
            className="flex items-center justify-center gap-2 rounded-sm bg-surface-container-low border border-outline-variant/30 px-8 py-3 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-all"
          >
            <X className="h-4 w-4" /> CANCEL
          </button>
        </div>
      </form>
    </div>
  );
}
