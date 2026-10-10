

import { ISSUE_CREATE_ATTACHMENTS_MAX } from "@forge/contracts/attachments";
import { type FormEvent, type RefObject, useRef, useState } from "react";
import { useRouter } from "@/lib/navigation/router";
import { Banner, Button, Field, Icon, Input, Select, SlideOver, Tabs, Textarea } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { useSubmitGuard } from "@/lib/utils/use-submit-guard";
import { useToast } from "@/providers/toast-provider";
import { useCreateIssue } from "../hooks";
import type { CreatedIssue, IssueComplexity, IssuePriority } from "../types";
import { BodyEditor } from "./body-editor";
import { StagedFileList, useStagedFiles } from "@/features/attachments";
import { useComplexityOptions, usePriorityOptions } from "./issue-table-row";

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

// core's code for a file it would not attach, read in the interface language; a code it adds later shows its own message
const ATTACHMENT_ERROR_COPY: Record<string, ProductCopyKey> = {
  ATTACHMENT_NAME_TAKEN: "issues.newIssue.dropped.nameTaken",
  MIME_NOT_ALLOWED: "issues.newIssue.dropped.mime",
  FILE_TOO_LARGE: "issues.newIssue.dropped.tooLarge",
  EMPTY_FILE: "issues.newIssue.dropped.empty",
  INVALID_NAME: "issues.newIssue.dropped.name",
};
function attachmentErrorCopy(dropped: { code?: string; message: string }, t: (key: ProductCopyKey) => string): string {
  const key = dropped.code ? ATTACHMENT_ERROR_COPY[dropped.code] : undefined;
  return key ? t(key) : dropped.message;
}

/** The toast a create answers with: the new key, or which files core would not attach and why. */
function announceCreated(created: CreatedIssue, toast: ReturnType<typeof useToast>["toast"], t: ReturnType<typeof useCopy>) {
  const dropped = created.attachmentErrors ?? [];
  if (dropped.length > 0) {
    const one = dropped.length === 1;
    toast({
      title: one ? t("issues.newIssue.droppedOne") : t("issues.newIssue.droppedMany", { n: dropped.length }),
      description: t(one ? "issues.newIssue.droppedHintOne" : "issues.newIssue.droppedHintMany", {
        files: dropped.map((e) => `${e.name} — ${attachmentErrorCopy(e, t)}`).join("; "),
      }),
      tone: "error",
    });
  } else {
    toast({ title: t("issues.activity.created"), description: created.displayId, tone: "success" });
  }
}

export function NewIssueDialog({ open, onClose, scope }: NewIssueDialogProps) {
  const t = useCopy();
  const create = useCreateIssue(scope.projectId);
  const titleRef = useRef<HTMLInputElement>(null);
  // a drawer dismissed mid-create reopens with its guard released, and a second submit would file a duplicate
  const dismiss = () => {
    if (!create.isPending) onClose();
  };
  return (
    <SlideOver open={open} onClose={dismiss} title={t("issues.newIssue")} width={480} initialFocus={titleRef}>
      {/* each opening starts a fresh draft: the form remounts rather than being reset */}
      <NewIssueForm key={String(open)} scope={scope} create={create} onClose={onClose} titleRef={titleRef} />
    </SlideOver>
  );
}

function NewIssueForm({
  scope,
  create,
  onClose,
  titleRef,
}: {
  scope: NewIssueDialogProps["scope"];
  create: ReturnType<typeof useCreateIssue>;
  onClose: () => void;
  titleRef: RefObject<HTMLInputElement | null>;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const submitting = useSubmitGuard();
  const t = useCopy();
  const modeTabs = [
    { value: "standard", label: t("issues.newIssue.mode.standard") },
    { value: "quick", label: t("issues.newIssue.mode.quick") },
  ];

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

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (trimmedTitle.length < 1) {
      setErrors({ title: t("issues.newIssue.titleRequired") });
      return;
    }
    if (trimmedTitle.length > 500) {
      setErrors({ title: t("issues.newIssue.titleTooLong", { max: 500 }) });
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
      announceCreated(created, toast, t);
      onClose();
      router.push(`/projects/${scope.slug}/issues/${created.id}`);
    } catch (err) {
      submitting.release();
      setErrors({ form: formatApiError(err) });
    }
  }

  return (
      <form
        onSubmit={(e) => void onSubmit(e)}
        // Quick capture sends no attachments — never stage invisible files there.
        onPaste={mode === "quick" ? undefined : staged.onPaste}
        className="flex h-full flex-col gap-4">
        <Tabs
          tabs={modeTabs}
          value={mode}
          onChange={(v) => {
            setMode(v as DialogMode);
            setErrors({});
          }}
        />

        {errors.form && <Banner tone="danger">{errors.form}</Banner>}


        <Field label={t("issues.newIssue.title")} required error={errors.title}>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={
              mode === "quick" ? t("issues.newIssue.quickPlaceholder") : t("issues.newIssue.titlePlaceholder")
            }
            ref={titleRef}
            maxLength={500}
          />
        </Field>

        {mode === "quick" && (
          <Field label={t("issues.newIssue.context")}>
            <Textarea
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder={t("issues.newIssue.contextPlaceholder")}
              maxLength={100_000}
              rows={5}
            />
          </Field>
        )}

        {mode === "standard" && (
          <StandardFields
            description={description}
            onDescription={setDescription}
            priority={priority}
            onPriority={setPriority}
            complexity={complexity}
            onComplexity={setComplexity}
            category={category}
            onCategory={setCategory}
            staged={staged}
          />
        )}

        <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={create.isPending}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" icon="plus" loading={create.isPending}>
            {mode === "quick" ? t("issues.newIssue.capture") : t("issues.newIssue.create")}
          </Button>
        </div>
      </form>
  );
}

/** The standard form's fields past the title: description, priority, complexity, category, files. */
function StandardFields({
  description,
  onDescription,
  priority,
  onPriority,
  complexity,
  onComplexity,
  category,
  onCategory,
  staged,
}: {
  description: string;
  onDescription: (v: string) => void;
  priority: IssuePriority;
  onPriority: (v: IssuePriority) => void;
  complexity: string;
  onComplexity: (v: string) => void;
  category: string;
  onCategory: (v: string) => void;
  staged: ReturnType<typeof useStagedFiles>;
}) {
  const t = useCopy();
  const priorityOptions = usePriorityOptions();
  const complexityOptions = useComplexityOptions();
  return (
    <>
        <Field label={t("issues.newIssue.description")}>
          <BodyEditor
            label={t("issues.newIssue.description")}
            value={description}
            onChange={onDescription}
            placeholder={t("issues.newIssue.descriptionPlaceholder")}
            rows={5}
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label={t("issues.field.priority")}>
            <Select
              aria-label={t("issues.field.priority")}
              value={priority}
              options={priorityOptions}
              onChange={(v) => onPriority(v as IssuePriority)}
            />
          </Field>
          <Field label={t("issues.field.complexity")} hint={t("issues.newIssue.optional")}>
            <Select
              aria-label={t("issues.field.complexity")}
              value={complexity}
              options={complexityOptions}
              onChange={onComplexity}
            />
          </Field>
        </div>

        <Field label={t("issues.category.label")}>
          <Input
            value={category}
            onChange={(e) => onCategory(e.target.value)}
            placeholder={t("issues.category.placeholder")}
            translate="no"
            maxLength={100}
          />
        </Field>

        <AttachmentsField staged={staged} />
    </>
  );
}

/** The files a new issue is filed with: dropped, chosen or pasted, checked before they are sent. */
function AttachmentsField({ staged }: { staged: ReturnType<typeof useStagedFiles> }) {
  const t = useCopy();
  return (
    <Field label={t("issues.attachments.title")}>
      <div
        {...staged.dropZone}
        className={`flex flex-col items-center justify-center gap-1.5 rounded-md border border-dashed px-4 py-5 text-center transition-colors ${
          staged.dragOver ? "border-info-8 bg-info-2/50" : "border-line-strong bg-sunken"
        }`}
      >
        <Icon name="plus" size={18} className="text-subtle" />
        <p className="fg-body-sm text-fg">{t("issues.newIssue.dropLead")}</p>
        <p className="fg-caption">{t("issues.newIssue.dropLimits", { max: ISSUE_CREATE_ATTACHMENTS_MAX })}</p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-1"
          onClick={staged.choose}
        >
          {t("issues.newIssue.choose")}
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
  );
}
