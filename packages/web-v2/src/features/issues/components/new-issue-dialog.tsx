"use client";


import { ISSUE_CREATE_ATTACHMENTS_MAX } from "@forge/contracts/attachments";
import { type FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Banner, Button, Field, Icon, Input, Select, SlideOver, Tabs, Textarea } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useSubmitGuard } from "@/lib/utils/use-submit-guard";
import { useToast } from "@/providers/toast-provider";
import { useCreateIssue } from "../hooks";
import type { CreatedIssue, IssueComplexity, IssuePriority } from "../types";
import { BodyEditor } from "./body-editor";
import { StagedFileList, useStagedFiles } from "@/features/attachments/components/staged-files";
import { COMPLEXITY_OPTIONS, PRIORITY_OPTIONS } from "./issue-table-row";

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

interface NewIssueDialogProps {
  open: boolean;
  onClose: () => void;
  scope: { projectId: string; slug: string };
}

type DialogMode = "standard" | "quick";

const MODE_TABS = [
  { value: "standard", label: "Standard" },
  { value: "quick", label: "Quick capture" },
];

const ATTACHMENT_ERROR_COPY: Record<string, string> = {
  ATTACHMENT_NAME_TAKEN: "this issue already has a file with that name",
  MIME_NOT_ALLOWED: "that file type isn't accepted",
  FILE_TOO_LARGE: "too large",
  EMPTY_FILE: "the file is empty",
  INVALID_NAME: "the name is too long",
};
function attachmentErrorCopy(dropped: { code?: string; message: string }): string {
  return (dropped.code && ATTACHMENT_ERROR_COPY[dropped.code]) || dropped.message;
}

export function NewIssueDialog({ open, onClose, scope }: NewIssueDialogProps) {
  const router = useRouter();
  const { toast } = useToast();
  const create = useCreateIssue(scope.projectId);
  const submitting = useSubmitGuard();

  const [mode, setMode] = useState<DialogMode>("standard");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  // Quick-capture context — kept separate from `description` so switching
  // tabs never silently carries a draft between the two forms.
  const [context, setContext] = useState("");
  const [priority, setPriority] = useState<IssuePriority>("medium");
  const [category, setCategory] = useState("");
  const [complexity, setComplexity] = useState("");
  const [errors, setErrors] = useState<{ title?: string; form?: string }>({});
  const staged = useStagedFiles({ unit: "issue", video: true, uniqueNames: true });
  const resetStaged = staged.reset;
  const resetCreate = create.reset;

  useEffect(() => {
    if (open) {
      setMode("standard");
      setTitle("");
      setDescription("");
      setContext("");
      setPriority("medium");
      setCategory("");
      setComplexity("");
      setErrors({});
      resetStaged();
      resetCreate();
      submitting.release();
    }
  }, [open, submitting, resetStaged, resetCreate]);

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
    if (!submitting.claim()) return;

    try {
      let created: CreatedIssue;
      if (mode === "quick") {
        const trimmedContext = context.trim();
        created = await create.mutateAsync({
          title: trimmedTitle,
          ...(trimmedContext ? { description: trimmedContext } : {}),
        });
      } else {
        const trimmedDesc = description.trim();
        const trimmedCategory = category.trim();
        const attachments = await Promise.all(
          staged.files.map(async (f) => ({
            name: f.name,
            mime: f.type || "application/octet-stream",
            dataBase64: await fileToBase64(f),
          })),
        );
        created = await create.mutateAsync({
          title: trimmedTitle,
          priority,
          ...(trimmedDesc ? { description: trimmedDesc } : {}),
          ...(trimmedCategory ? { category: trimmedCategory } : {}),
          ...(complexity ? { complexity: complexity as IssueComplexity } : {}),
          ...(attachments.length ? { attachments } : {}),
        });
      }
      const dropped = created.attachmentErrors ?? [];
      if (dropped.length > 0) {
        toast({
          title: `Issue created, but ${dropped.length === 1 ? "1 file was" : `${dropped.length} files were`} not attached`,
          description: `${dropped.map((e) => `${e.name} — ${attachmentErrorCopy(e)}`).join("; ")}. Open the issue and attach ${dropped.length === 1 ? "it" : "them"} again.`,
          tone: "error",
        });
      } else {
        toast({ title: "Issue created", description: created.displayId, tone: "success" });
      }
      onClose();
      router.push(`/projects/${scope.slug}/issues/${created.id}`);
    } catch (err) {
      submitting.release();
      setErrors({ form: formatApiError(err) });
    }
  }

  // a drawer dismissed mid-create reopens with its guard released, and a second submit would file a duplicate
  const dismiss = () => {
    if (!create.isPending) onClose();
  };

  return (
    <SlideOver open={open} onClose={dismiss} title="New issue" width={480}>
      <form
        onSubmit={onSubmit}
        // Quick capture sends no attachments — never stage invisible files there.
        onPaste={mode === "quick" ? undefined : staged.onPaste}
        className="flex h-full flex-col gap-4">
        <Tabs
          tabs={MODE_TABS}
          value={mode}
          onChange={(v) => {
            setMode(v as DialogMode);
            setErrors({});
          }}
        />

        {errors.form && <Banner tone="danger">{errors.form}</Banner>}

        <p className="fg-caption">
          An issue is <strong>work</strong> with a deliverable someone else can verify. A note,
          a question, or a record of something already done is not an issue —{" "}
          <a
            href="/docs?path=file-a-request"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            what to write, and what counts as an issue
          </a>
          .
        </p>

        <Field label="Title" required error={errors.title}>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={
              mode === "quick" ? "One-line request…" : "Short summary of the issue"
            }
            autoFocus
            maxLength={500}
          />
        </Field>

        {mode === "quick" && (
          <Field
            label="Context"
            hint="Optional — anything triage needs to act without asking back. Saved as the description and AI summary."
          >
            <Textarea
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="Why this matters, where it happens, links…"
              maxLength={100_000}
              rows={5}
            />
          </Field>
        )}

        {mode === "standard" && (
          <>
            <Field label="Description" hint="Optional — context, repro steps, or links.">
              <BodyEditor
                label="Description"
                value={description}
                onChange={setDescription}
                placeholder="What needs to happen and why…"
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
                {...staged.dropZone}
                className={`flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-5 text-center transition-colors ${
                  staged.dragOver ? "border-cobalt-400 bg-cobalt-50/50" : "border-line-strong bg-sunken"
                }`}
              >
                <Icon name="plus" size={18} className="text-subtle" />
                <p className="fg-body-sm text-fg">Drop files or paste an image to attach</p>
                <p className="fg-caption">
                  Max 10 MB each · up to {ISSUE_CREATE_ATTACHMENTS_MAX} · images, video, PDF, Word, Excel, and any
                  plain-text file whatever its extension — .log and .sql included.
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="mt-1"
                  onClick={staged.choose}
                >
                  Choose files
                </Button>
                {staged.input}
              </div>

              <StagedFileList
                files={staged.files}
                warnings={staged.warnings}
                remove={staged.remove}
                spaced
              />
            </Field>
          </>
        )}

        <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon="plus" loading={create.isPending}>
            {mode === "quick" ? "Capture issue" : "Create issue"}
          </Button>
        </div>
      </form>
    </SlideOver>
  );
}
