import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getProject, createIssue } from "@/lib/api";
import type { IssuePriority } from "@/lib/types";
import { AlertBanner } from "@/components/ui/alert-banner";
import { PageShell } from "@/components/ui/page-shell";
import { FormInput, FormTextarea } from "@/components/ui/form-input";
import { FileUpload, type UploadedFile } from "@/components/ui/file-upload";

export function NewIssuePage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { data: project } = useQuery({
    queryKey: ["project", slug],
    queryFn: () => getProject(slug!),
    enabled: !!slug,
  });

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<IssuePriority>("medium");
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project || !title.trim()) return;

    setSubmitting(true);
    setError(null);
    try {
      await createIssue({
        title,
        description,
        priority,
        project: project.documentId,
        ...(attachments.length > 0 ? { attachments: attachments.map((a) => a.id) } : {}),
      });
      navigate(`/project/${slug}/issues`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create issue.");
      setSubmitting(false);
    }
  };

  return (
    <PageShell title="Create New Issue">
      {error && (
        <div className="mb-4">
          <AlertBanner variant="error">{error}</AlertBanner>
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="title" className="mb-1 block text-sm font-medium text-gray-700">Title</label>
          <FormInput
            id="title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            placeholder="Issue title"
          />
        </div>

        <div>
          <label htmlFor="description" className="mb-1 block text-sm font-medium text-gray-700">Description</label>
          <FormTextarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={6}
            placeholder="Describe the issue..."
          />
        </div>

        <div>
          <label htmlFor="priority" className="mb-1 block text-sm font-medium text-gray-700">Priority</label>
          <select
            id="priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value as IssuePriority)}
            className="rounded-lg border border-gray-200 px-3 py-2 text-sm"
          >
            <option value="none">None</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Attachments</label>
          <FileUpload value={attachments} onChange={setAttachments} />
        </div>

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={submitting || !title.trim()}
            className="rounded-lg bg-black px-4 py-2 text-sm text-white hover:bg-gray-800 disabled:opacity-50"
          >
            {submitting ? "Creating..." : "Create Issue"}
          </button>
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
        </div>
      </form>
    </PageShell>
  );
}
