'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { Plus, Trash2, Upload } from 'lucide-react';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import {
  useKnowledgeEdges,
  useCreateKnowledgeEdge,
  useDeleteKnowledgeEdge,
  useIngestKnowledge,
} from '@/features/knowledge/hooks/use-knowledge';
import { Skeleton } from '@/components/ui/skeleton';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { formatApiError } from '@/lib/api/error';

export default function KnowledgePage() {
  useSetPageTitle('Knowledge');
  const { slug } = useParams<{ slug: string }>();
  const project = useProjectBySlug(slug);
  const projectId = project?.id;

  const edgesQuery = useKnowledgeEdges(projectId);
  const createEdge = useCreateKnowledgeEdge();
  const deleteEdge = useDeleteKnowledgeEdge(projectId);
  const ingest = useIngestKnowledge(projectId);

  const [showEdgeForm, setShowEdgeForm] = useState(false);
  const [showIngest, setShowIngest] = useState(false);
  const [subject, setSubject] = useState('');
  const [predicate, setPredicate] = useState('');
  const [object, setObject] = useState('');
  const [value, setValue] = useState('');

  const [docTitle, setDocTitle] = useState('');
  const [docContent, setDocContent] = useState('');

  function handleCreateEdge(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) return;
    if (!subject.trim() || !predicate.trim() || !object.trim()) return;
    createEdge.mutate(
      {
        projectId,
        subject: subject.trim(),
        predicate: predicate.trim(),
        object: object.trim(),
        value: value.trim() || null,
      },
      {
        onSuccess: () => {
          setSubject('');
          setPredicate('');
          setObject('');
          setValue('');
          setShowEdgeForm(false);
        },
      },
    );
  }

  function handleIngest(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) return;
    if (!docTitle.trim() || !docContent.trim()) return;
    ingest.mutate(
      [
        {
          id: `manual-${Date.now()}`,
          title: docTitle.trim(),
          content: docContent,
        },
      ],
      {
        onSuccess: () => {
          setDocTitle('');
          setDocContent('');
          setShowIngest(false);
        },
      },
    );
  }

  function handleDelete(id: string, label: string) {
    if (!confirm(`Delete edge "${label}"?`)) return;
    deleteEdge.mutate(id);
  }

  const edges = edgesQuery.data ?? [];

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-on-surface">Knowledge graph</h1>
          <p className="text-sm text-primary-fixed">
            Subject–predicate–object edges and ingested documents for this project.
            Visual graph canvas ships in v0.1.x.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setShowIngest((v) => !v);
              setShowEdgeForm(false);
            }}
            className="inline-flex items-center gap-1.5 rounded-sm border border-outline-variant/30 bg-surface-container px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-on-surface hover:bg-surface-container-high"
          >
            <Upload className="h-3.5 w-3.5" />
            Ingest text
          </button>
          <button
            type="button"
            onClick={() => {
              setShowEdgeForm((v) => !v);
              setShowIngest(false);
            }}
            className="inline-flex items-center gap-1.5 rounded-sm border border-outline-variant/30 bg-primary px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-on-primary hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" />
            New edge
          </button>
        </div>
      </div>

      {showEdgeForm && projectId && (
        <form
          onSubmit={handleCreateEdge}
          className="space-y-3 rounded-sm border border-primary/30 bg-surface-container-low p-4"
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              className="rounded border border-outline-variant/30 bg-surface px-3 py-2 text-sm"
              required
            />
            <input
              value={predicate}
              onChange={(e) => setPredicate(e.target.value)}
              placeholder="Predicate"
              className="rounded border border-outline-variant/30 bg-surface px-3 py-2 text-sm"
              required
            />
            <input
              value={object}
              onChange={(e) => setObject(e.target.value)}
              placeholder="Object"
              className="rounded border border-outline-variant/30 bg-surface px-3 py-2 text-sm"
              required
            />
          </div>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Optional value / note"
            className="w-full rounded border border-outline-variant/30 bg-surface px-3 py-2 text-sm"
          />
          {createEdge.error && (
            <p className="text-[10px] uppercase tracking-widest text-error">
              {formatApiError(createEdge.error)}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowEdgeForm(false)}
              className="rounded px-3 py-1.5 text-xs text-primary-fixed hover:bg-surface-container-high"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createEdge.isPending}
              className="rounded bg-primary px-3 py-1.5 text-xs text-on-primary hover:bg-primary/90 disabled:opacity-50"
            >
              {createEdge.isPending ? 'Creating…' : 'Create edge'}
            </button>
          </div>
        </form>
      )}

      {showIngest && projectId && (
        <form
          onSubmit={handleIngest}
          className="space-y-3 rounded-sm border border-info/30 bg-surface-container-low p-4"
        >
          <input
            value={docTitle}
            onChange={(e) => setDocTitle(e.target.value)}
            placeholder="Document title"
            className="w-full rounded border border-outline-variant/30 bg-surface px-3 py-2 text-sm"
            required
          />
          <textarea
            value={docContent}
            onChange={(e) => setDocContent(e.target.value)}
            placeholder="Paste content to index into the project memory…"
            rows={8}
            className="w-full rounded border border-outline-variant/30 bg-surface px-3 py-2 font-mono text-xs"
            required
          />
          {ingest.error && (
            <p className="text-[10px] uppercase tracking-widest text-error">
              {formatApiError(ingest.error)}
            </p>
          )}
          {ingest.data && (
            <p className="text-[10px] uppercase tracking-widest text-success">
              Ingested {ingest.data.processed} doc · {ingest.data.totalChunks} chunks
              {ingest.data.skipped.length > 0
                ? ` · ${ingest.data.skipped.length} skipped`
                : ''}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowIngest(false)}
              className="rounded px-3 py-1.5 text-xs text-primary-fixed hover:bg-surface-container-high"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={ingest.isPending}
              className="rounded bg-primary px-3 py-1.5 text-xs text-on-primary hover:bg-primary/90 disabled:opacity-50"
            >
              {ingest.isPending ? 'Ingesting…' : 'Ingest'}
            </button>
          </div>
        </form>
      )}

      {!projectId ? (
        <p className="text-sm text-primary-fixed">Loading project…</p>
      ) : edgesQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : edgesQuery.error ? (
        <p className="text-[10px] uppercase tracking-widest text-error">
          {formatApiError(edgesQuery.error)}
        </p>
      ) : edges.length === 0 ? (
        <div className="rounded-lg border border-dashed border-outline-variant/30 px-4 py-12 text-center">
          <p className="text-sm text-primary-fixed">No knowledge edges yet.</p>
          <p className="mt-1 text-xs text-outline">
            Add edges manually or ingest text to populate project knowledge.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-outline-variant/30">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-outline-variant/20 bg-surface-container-low text-xs text-primary-fixed">
                <th className="px-4 py-2.5 font-medium">Subject</th>
                <th className="px-4 py-2.5 font-medium">Predicate</th>
                <th className="px-4 py-2.5 font-medium">Object</th>
                <th className="hidden px-4 py-2.5 font-medium md:table-cell">Value</th>
                <th className="px-4 py-2.5 font-medium">Confidence</th>
                <th className="px-4 py-2.5 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/20">
              {edges.map((e) => (
                <tr key={e.id} className="bg-surface-container-low">
                  <td className="px-4 py-2.5 font-medium text-on-surface">{e.subject}</td>
                  <td className="px-4 py-2.5 text-primary-fixed">{e.predicate}</td>
                  <td className="px-4 py-2.5 text-on-surface">{e.object}</td>
                  <td className="hidden max-w-[280px] truncate px-4 py-2.5 text-xs text-outline md:table-cell">
                    {e.value ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-primary-fixed">
                    {(e.confidence * 100).toFixed(0)}%
                  </td>
                  <td className="px-4 py-2.5">
                    <button
                      onClick={() =>
                        handleDelete(e.id, `${e.subject} ${e.predicate} ${e.object}`)
                      }
                      className="rounded p-1 text-outline hover:bg-danger-surface hover:text-danger"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
