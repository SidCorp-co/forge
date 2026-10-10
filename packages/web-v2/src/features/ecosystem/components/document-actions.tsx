
import { Link } from "@/lib/navigation/router";
import { useState } from "react";
import { Button, Input, Textarea } from "@/design";
import type { ProjectListItem } from "@/features/projects";
import { canWriteProject } from "@/features/projects";
import { ecosystemApi } from "../api";
import { useChannelWrite } from "../hooks";
import { refusalsOf } from "@/lib/api/refusals";
import { ecosystemRoutes } from "../routes";
import { type DocumentView, REPLY_TYPES } from "../types";
import { ReadOnlyNotice, RefusalNotice } from "./notices";
import { useCopy } from "@/lib/i18n/interface-language";

export type Role = ProjectListItem["role"];

/** Whether the reader's side owes this document a reply it can write. */
function owesReply(view: DocumentView): boolean {
  const d = view.document;
  if (view.side !== "recipient" || d.state !== "published") return false;
  if ((REPLY_TYPES[d.type] ?? []).length === 0) return false;
  return !(d.type === "change-notice" && d.body.binding === false);
}

/**
 * One write that may need a reason. Its refusal is shown under it by name and stays until the
 * next attempt; nothing here ever reports a refused write as done.
 */
export function ReasonAction({
  label,
  confirmLabel,
  reason,
  extra,
  run,
  variant = "secondary",
}: {
  label: string;
  confirmLabel: string;
  reason: "required" | "optional" | "none";
  extra?: { label: string; placeholder: string };
  run: (reason: string, extra: string) => Promise<unknown>;
  variant?: "secondary" | "danger" | "primary";
}) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [more, setMore] = useState("");
  const write = useChannelWrite(({ r, e }: { r: string; e: string }) => run(r, e));
  const go = () => write.mutate({ r: text.trim(), e: more.trim() }, { onSuccess: () => setOpen(false) });
  if (reason === "none") {
    return (
      <div className="space-y-2">
        <Button variant={variant} size="sm" loading={write.isPending} onClick={go}>
          {label}
        </Button>
        {write.isError ? <RefusalNotice refusals={refusalsOf(write.error)} /> : null}
      </div>
    );
  }
  return (
    <div className="w-full space-y-2 sm:w-auto">
      {open ? (
        <div className="space-y-2 rounded-md border border-line p-2">
          {extra ? (
            <Input aria-label={extra.label} placeholder={extra.placeholder} value={more} onChange={(e) => setMore(e.target.value)} />
          ) : null}
          <Textarea
            aria-label={t("ecosystem.reason.aria", { label })}
            rows={2}
            placeholder={t(reason === "required" ? "ecosystem.reason.required" : "ecosystem.reason.optional")}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant={variant}
              size="sm"
              loading={write.isPending}
              disabled={(reason === "required" && text.trim() === "") || (extra !== undefined && more.trim() === "")}
              onClick={go}
            >
              {confirmLabel}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {t("ecosystem.reason.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant={variant} size="sm" onClick={() => setOpen(true)}>
          {label}
        </Button>
      )}
      {write.isError ? <RefusalNotice refusals={refusalsOf(write.error)} /> : null}
    </div>
  );
}

function DraftActions({ view, projectId, slug }: { view: DocumentView; projectId: string; slug: string }) {
  const t = useCopy();
  return (
    <>
      <Link
        href={ecosystemRoutes.compose(slug, { draft: view.id })}
        className="inline-flex items-center rounded-md border border-line-strong px-2.75 py-1.5 text-13 hover:bg-hover"
      >
        {t("ecosystem.doc.editDraft")}
      </Link>
      {/* Core submits only a draft; an edit is what turns a returned document back into one. */}
      {view.document.state === "draft" ? (
        <ReasonAction
          label={t("ecosystem.doc.submit")}
          confirmLabel={t("ecosystem.doc.submit")}
          reason="none"
          variant="primary"
          run={() => ecosystemApi.submit(projectId, view.id)}
        />
      ) : null}
    </>
  );
}

function HoldAction({ projectId, thread, held }: { projectId: string; thread: string; held: boolean }) {
  const t = useCopy();
  return held ? (
    <ReasonAction
      label={t("ecosystem.doc.releaseConversation")}
      confirmLabel={t("ecosystem.action.release")}
      reason="optional"
      run={(reason) => ecosystemApi.hold(projectId, thread, "release", reason || undefined)}
    />
  ) : (
    <ReasonAction
      label={t("ecosystem.doc.holdConversation")}
      confirmLabel={t("ecosystem.action.hold")}
      reason="required"
      run={(reason) => ecosystemApi.hold(projectId, thread, "hold", reason)}
    />
  );
}

export function DocumentActions({ view, projectId, slug, role }: { view: DocumentView; projectId: string; slug: string; role: Role }) {
  const t = useCopy();
  const d = view.document;
  if (!canWriteProject(role)) {
    return <ReadOnlyNotice role={role} slug={slug} />;
  }
  const sender = view.side === "sender";
  const editable = sender && (d.state === "draft" || d.state === "returned");
  const standing = sender && d.state === "published";
  return (
    <div className="flex flex-wrap items-start gap-2">
      {editable ? <DraftActions view={view} projectId={projectId} slug={slug} /> : null}
      {owesReply(view) && d.number ? (
        <Link
          href={ecosystemRoutes.compose(slug, { inReplyTo: d.number, ecosystem: d.ecosystem })}
          className="inline-flex items-center rounded-md bg-accent px-2.75 py-1.5 text-13 text-on-accent"
        >
          {t("ecosystem.doc.reply")}
        </Link>
      ) : null}
      {standing ? (
        <>
          <ReasonAction
            label={t("ecosystem.doc.withdraw")}
            confirmLabel={t("ecosystem.doc.withdrawIt")}
            reason="required"
            variant="danger"
            run={(reason) => ecosystemApi.withdraw(projectId, view.id, reason)}
          />
          <ReasonAction
            label={t("ecosystem.doc.supersede")}
            confirmLabel={t("ecosystem.doc.supersedeIt")}
            reason="required"
            extra={{ label: t("ecosystem.doc.replacement"), placeholder: t("ecosystem.doc.replacementPlaceholder") }}
            run={(reason, by) => ecosystemApi.supersede(projectId, view.id, by, reason)}
          />
        </>
      ) : null}
      {view.thread && d.state === "published" ? (
        <HoldAction projectId={projectId} thread={view.thread} held={view.hold?.action === "hold"} />
      ) : null}
    </div>
  );
}
