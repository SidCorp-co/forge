"use client";

// Create-issue flow (ISS-331). A SlideOver-hosted form wired to
// `POST /api/projects/:id/issues` via `useCreateIssue`. Title is required
// (mirrors the server schema); priority defaults to `medium`; description,
// category, and complexity are optional. On success we invalidate `['issues']`
// (done by the hook) and navigate to the new issue's detail page. Modeled on
// the New Project dialog (ISS-319).
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { Banner, Button, Field, Icon, IconButton, Input, Select, SlideOver, Textarea } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { useCreateIssue } from "../hooks";
import type { IssueComplexity, IssuePriority } from "../types";
import { COMPLEXITY_OPTIONS, PRIORITY_OPTIONS } from "./issue-table-row";

// Attachment staging limits — mirror core's `issueCreateSchema` allow-list so
// we reject client-side before burning an upload round-trip.
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10;
const ALLOWED_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "text/plain",
  "text/markdown",
]);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export interface NewIssueDialogProps {
  open: boolean;
  onClose: () => void;
  scope: { projectId: string; slug: string };
}

export function NewIssueDialog({ open, onClose, scope }: NewIssueDialogProps) {
  const router = useRouter();
  const { toast } = useToast();
  const create = useCreateIssue(scope.projectId);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<IssuePriority>("medium");
  const [category, setCategory] = useState("");
  const [complexity, setComplexity] = useState("");
  const [errors, setErrors] = useState<{ title?: string; form?: string }>({});
  const [files, setFiles] = useState<File[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset the whole form each time the dialog opens — never leak a prior draft
  // or stale error into a fresh create.
  useEffect(() => {
    if (open) {
      setTitle("");
      setDescription("");
      setPriority("medium");
      setCategory("");
      setComplexity("");
      setErrors({});
      setFiles([]);
      setWarnings([]);
      setDragOver(false);
      create.reset();
    }
    // `create` is stable from React Query; resetting only on `open` is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Validate + stage picked/dropped/pasted files. Mirrors the V1 create page
  // (size/mime/count caps) so the server never rejects what we accepted.
  const acceptFiles = useCallback((picked: FileList | File[]) => {
    const accepted: File[] = [];
    const errs: string[] = [];
    for (const f of Array.from(picked)) {
      if (f.size <= 0) {
        errs.push(`Empty file skipped: ${f.name || "(unnamed)"}`);
        continue;
      }
      if (f.size > MAX_BYTES) {
        errs.push(`Too large (max 10 MB): ${f.name || "(unnamed)"}`);
        continue;
      }
      const mime = f.type || "application/octet-stream";
      if (!ALLOWED_MIMES.has(mime)) {
        errs.push(`File type not allowed: ${f.name || mime}`);
        continue;
      }
      accepted.push(f);
    }
    setFiles((prev) => {
      const room = MAX_FILES - prev.length;
      if (accepted.length > room) {
        errs.push(`Max ${MAX_FILES} attachments per issue. Extras skipped.`);
      }
      return [...prev, ...accepted.slice(0, Math.max(0, room))];
    });
    setWarnings(errs);
  }, []);

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files?.length) acceptFiles(e.dataTransfer.files);
    },
    [acceptFiles],
  );

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files?.length) acceptFiles(e.target.files);
      e.target.value = "";
    },
    [acceptFiles],
  );

  // Clipboard paste of a copied/screenshotted image. Only file blobs (kind ===
  // "file") are pulled in; pasted text falls through to the normal Textarea so
  // we never double-insert. Clipboard images often have an empty name → supply
  // a fallback so the chip + server validation have something to show.
  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const blobs: File[] = [];
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (!file) continue;
          if (file.name) {
            blobs.push(file);
          } else {
            const ext = item.type.split("/")[1] ?? "png";
            blobs.push(
              new File([file], `pasted-${blobs.length + 1}.${ext}`, { type: item.type }),
            );
          }
        }
      }
      if (blobs.length) {
        e.preventDefault();
        acceptFiles(blobs);
      }
    },
    [acceptFiles],
  );

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setWarnings([]);
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (trimmedTitle.length < 1) {
      setErrors({ title: "Title is required." });
      return;
    }
    if (trimmedTitle.length > 500) {
      setErrors({ title: "Title must be 500 characters or fewer." });
      return;
    }
    setErrors({});

    const trimmedDesc = description.trim();
    const trimmedCategory = category.trim();
    try {
      const attachments = await Promise.all(
        files.map(async (f) => ({
          name: f.name,
          mime: f.type || "application/octet-stream",
          dataBase64: await fileToBase64(f),
        })),
      );
      const created = await create.mutateAsync({
        title: trimmedTitle,
        priority,
        ...(trimmedDesc ? { description: trimmedDesc } : {}),
        ...(trimmedCategory ? { category: trimmedCategory } : {}),
        ...(complexity ? { complexity: complexity as IssueComplexity } : {}),
        ...(attachments.length ? { attachments } : {}),
      });
      toast({ title: "Issue created", description: created.displayId, tone: "success" });
      onClose();
      router.push(`/projects/${scope.slug}/issues/${created.id}`);
    } catch (err) {
      setErrors({ form: formatApiError(err) });
    }
  }

  return (
    <SlideOver open={open} onClose={onClose} title="New issue" width={480}>
      <form onSubmit={onSubmit} onPaste={onPaste} className="flex h-full flex-col gap-4">
        {errors.form && <Banner tone="danger">{errors.form}</Banner>}

        <Field label="Title" required error={errors.title}>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Short summary of the issue"
            autoFocus
            maxLength={500}
          />
        </Field>

        <Field label="Description" hint="Optional — context, repro steps, or links.">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What needs to happen and why…"
            maxLength={100_000}
            rows={5}
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Priority">
            <Select
              aria-label="Priority"
              value={priority}
              options={PRIORITY_OPTIONS}
              onChange={(v) => setPriority(v as IssuePriority)}
            />
          </Field>
          <Field label="Complexity" hint="Optional.">
            <Select
              aria-label="Complexity"
              value={complexity}
              options={COMPLEXITY_OPTIONS}
              onChange={setComplexity}
            />
          </Field>
        </div>

        <Field label="Category" hint="Optional — e.g. bug, feature, chore.">
          <Input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="bug"
            maxLength={100}
          />
        </Field>

        <Field
          label="Attachments"
          hint="Optional — drop files, choose them, or paste a screenshot (⌘/Ctrl+V)."
        >
          <div
            onDrop={onDrop}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            className={`flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-5 text-center transition-colors ${
              dragOver ? "border-cobalt-400 bg-cobalt-50/50" : "border-line-strong bg-sunken"
            }`}
          >
            <Icon name="plus" size={18} className="text-subtle" />
            <p className="fg-body-sm text-fg">Drop files or paste an image to attach</p>
            <p className="fg-caption">
              Max 10 MB each · up to {MAX_FILES} · images, video, PDF, text, markdown.
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-1"
              onClick={() => fileInputRef.current?.click()}
            >
              Choose files
            </Button>
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onPick} />
          </div>

          {warnings.length > 0 && (
            <div className="mt-2">
              <Banner tone="attention">
                <ul className="space-y-0.5">
                  {warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </Banner>
            </div>
          )}

          {files.length > 0 && (
            <ul className="mt-2.5 flex flex-col gap-1.5">
              {files.map((f, i) => (
                <li
                  key={`${f.name}-${i}`}
                  className="flex items-center gap-2.5 rounded-md border border-line-subtle bg-surface px-2.5 py-1.5"
                >
                  <Icon
                    name={f.type.startsWith("image/") ? "grid" : "folder"}
                    size={15}
                    className="flex-none text-subtle"
                  />
                  <span className="fg-body-sm min-w-0 flex-1 truncate text-fg" title={f.name}>
                    {f.name}
                  </span>
                  <span className="fg-caption flex-none">{formatSize(f.size)}</span>
                  <IconButton
                    type="button"
                    icon="x"
                    size="sm"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => removeFile(i)}
                  />
                </li>
              ))}
            </ul>
          )}
        </Field>

        <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon="plus" loading={create.isPending}>
            Create issue
          </Button>
        </div>
      </form>
    </SlideOver>
  );
}
