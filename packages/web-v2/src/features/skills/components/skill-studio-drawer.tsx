"use client";

// Skill Studio — a slide-over that authors a skill as its on-disk folder:
// SKILL.md (metadata fields + body; frontmatter auto-generated) plus supporting
// files in subfolders (references/, scripts/, …). Backed by POST/PUT /api/skills
// which accept the full `files[]` array. Used for both create and edit.
import { useEffect, useState } from "react";
import {
  Banner,
  Button,
  Field,
  Icon,
  Input,
  Select,
  type SelectOption,
  SlideOver,
  Textarea,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCreateSkill, useUpdateSkill } from "../hooks";
import {
  buildSkillMd,
  splitSkillMd,
  type SkillFile,
  type SkillRow,
  type SkillTarget,
} from "../types";
import { CodeEditor } from "./code-editor";

const SKILL_MD = "SKILL.md";
const NEW_BODY = "## When to use\n\nDescribe when this skill should run.\n";

const TARGET_OPTIONS: SelectOption[] = [
  { value: "all", label: "All runtimes" },
  { value: "cloud", label: "Cloud only" },
  { value: "dev", label: "Desktop only" },
];

/** Validate a new file path against the runner's constraints + uniqueness. */
function pathError(raw: string, files: SkillFile[]): string | null {
  const p = raw.trim();
  if (!p) return "Path is required.";
  if (p.length > 500) return "Path is too long (max 500).";
  if (p === SKILL_MD) return "SKILL.md is edited separately.";
  if (p.startsWith("/") || p.split("/").includes("..")) return "Use a relative path, no '..'.";
  if (files.some((f) => f.path === p)) return "A file with that path already exists.";
  return null;
}

function FileRow({
  label,
  active,
  onClick,
  onRemove,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  onRemove?: () => void;
}) {
  return (
    <div
      className={`group flex items-center gap-1 rounded-md px-2 py-1 ${
        active ? "bg-accent-tint text-accent-text" : "hover:bg-hover"
      }`}
    >
      <button
        type="button"
        onClick={onClick}
        className="fg-caption min-w-0 flex-1 truncate text-left"
      >
        {label}
      </button>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
          className="grid size-5 place-items-center rounded-sm text-subtle opacity-0 transition hover:bg-hover hover:text-fg group-hover:opacity-100"
        >
          <Icon name="x" size={12} />
        </button>
      )}
    </div>
  );
}

export function SkillStudioDrawer({
  open,
  onClose,
  projectId,
  skill,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** Present → edit that project skill; absent → create a new one. */
  skill?: SkillRow | null;
}) {
  const isEdit = !!skill;
  const create = useCreateSkill(projectId);
  const update = useUpdateSkill(projectId);
  const pending = create.isPending || update.isPending;
  const mutErr = create.error ?? update.error;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [target, setTarget] = useState<SkillTarget>("all");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<SkillFile[]>([]);
  const [active, setActive] = useState<string>(SKILL_MD);
  const [newPath, setNewPath] = useState("");
  const [formErr, setFormErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(skill?.name ?? "");
    setDescription(skill?.description ?? "");
    setTarget(skill?.target ?? "all");
    setBody(skill ? splitSkillMd(skill.skillMd) : NEW_BODY);
    setFiles(skill?.files ?? []);
    setActive(SKILL_MD);
    setNewPath("");
    setFormErr(null);
    create.reset();
    update.reset();
    // Re-seed only when the drawer opens or switches target skill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, skill?.id]);

  const activeFile = active === SKILL_MD ? null : (files.find((f) => f.path === active) ?? null);

  function addFile() {
    const err = pathError(newPath, files);
    if (err) {
      setFormErr(err);
      return;
    }
    const p = newPath.trim();
    setFiles((fs) =>
      [...fs, { path: p, content: "", encoding: "utf8" as const }].sort((a, b) =>
        a.path.localeCompare(b.path),
      ),
    );
    setActive(p);
    setNewPath("");
    setFormErr(null);
  }

  function removeFile(path: string) {
    setFiles((fs) => fs.filter((f) => f.path !== path));
    if (active === path) setActive(SKILL_MD);
  }

  async function save() {
    if (!name.trim()) {
      setFormErr("Name is required.");
      setActive(SKILL_MD);
      return;
    }
    setFormErr(null);
    const payload = {
      name: name.trim(),
      description: description.trim(),
      skillMd: buildSkillMd({ name: name.trim(), description: description.trim(), body }),
      target,
      files,
    };
    try {
      if (isEdit && skill) await update.mutateAsync({ skillId: skill.id, patch: payload });
      else await create.mutateAsync(payload);
      onClose();
    } catch {
      // surfaced via the mutation-error Banner
    }
  }

  return (
    <SlideOver
      open={open}
      onClose={onClose}
      title={isEdit ? `Edit ${skill?.name}` : "New skill"}
      width={880}
    >
      <div className="space-y-4">
        {(formErr || mutErr) && (
          <Banner
            tone="danger"
            onDismiss={() => {
              setFormErr(null);
              create.reset();
              update.reset();
            }}
          >
            {formErr ?? formatApiError(mutErr)}
          </Banner>
        )}

        <div className="flex gap-4">
          <aside className="w-52 shrink-0">
            <p className="fg-overline mb-1.5">Files</p>
            <div className="space-y-0.5">
              <FileRow
                label={SKILL_MD}
                active={active === SKILL_MD}
                onClick={() => setActive(SKILL_MD)}
              />
              {files.map((f) => (
                <FileRow
                  key={f.path}
                  label={f.path}
                  active={active === f.path}
                  onClick={() => setActive(f.path)}
                  onRemove={() => removeFile(f.path)}
                />
              ))}
            </div>
            <div className="mt-2 flex items-center gap-1">
              <Input
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder="references/foo.md"
                className="min-w-0 flex-1"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addFile();
                  }
                }}
              />
              <Button variant="secondary" size="sm" icon="plus" onClick={addFile} aria-label="Add file" />
            </div>
          </aside>

          <div className="min-w-0 flex-1 space-y-3">
            {active === SKILL_MD ? (
              <>
                <Field label="Name" required>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="forge-triage"
                  />
                </Field>
                <Field label="Description">
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={2}
                    placeholder="What this skill does and when it runs…"
                  />
                </Field>
                <Field label="Runtime target">
                  <Select
                    options={TARGET_OPTIONS}
                    value={target}
                    onChange={(v) => setTarget(v as SkillTarget)}
                  />
                </Field>
                <div>
                  <p className="fg-label mb-1">SKILL.md body</p>
                  <CodeEditor path="SKILL.md" value={body} onChange={setBody} />
                  <p className="fg-caption mt-1 text-muted">
                    Frontmatter (name, description) is generated automatically on save.
                  </p>
                </div>
              </>
            ) : activeFile ? (
              <div>
                <p className="fg-label mb-1 break-all">{activeFile.path}</p>
                <CodeEditor
                  path={activeFile.path}
                  value={activeFile.content}
                  onChange={(v) =>
                    setFiles((fs) =>
                      fs.map((f) => (f.path === activeFile.path ? { ...f, content: v } : f)),
                    )
                  }
                />
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={() => void save()}>
            {isEdit ? "Save changes" : "Create skill"}
          </Button>
        </div>
      </div>
    </SlideOver>
  );
}
