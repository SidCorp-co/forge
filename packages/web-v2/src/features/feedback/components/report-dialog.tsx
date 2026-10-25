// Feedback from any page (REQ-66 BC-1): in a project, one sentence and the page's screenshot, filed
// into that project as the signed-in person; the agent fills the kind and severity, and a repeat joins
// the open item it repeats (BC-3). Feedback about Forge itself is the other choice, as it is the only
// one outside a project (REQ-47 BC-9). On a project that redacts, the reporter hides what is personal
// and says so before an agent may see the screenshot (BC-7).

import { FEEDBACK_LIMITS, FEEDBACK_REPORT_KINDS, type FeedbackReportResponse } from "@forge/contracts/feedback";
import { SENSITIVE_DATA_LEVELS, type SensitiveDataLevel } from "@forge/contracts/data-policy";
import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { Button, Checkbox, Dialog, enumLabel, Field, focusOnMount, NativeSelect, SegmentedControl, Textarea } from "@/design";
import { useProjectDocument } from "@/features/project-config";
import { type ProjectListItem, useCurrentProject } from "@/features/projects";
import { placeRefusals } from "@/lib/api/field-refusals";
import { namedRefusals } from "@/lib/api/refusals";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { Link, usePathname } from "@/lib/navigation/router";
import { feedbackHref } from "@/lib/routes/feedback";
import { useLocationSearch } from "@/lib/utils/use-location-search";
import { useSubmitGuard } from "@/lib/utils/use-submit-guard";
import { base64Of, capturePage } from "../capture";
import { useReportFeedback } from "../hooks";
import type { ForgeFeedbackFiled } from "../types";
import { ForgeFeedbackButton, ForgeFeedbackFiledNote, ForgeFeedbackForm } from "./forge-feedback-dialog";

const FIELDS = { said: ["/said"], kind: ["/kind"], shot: ["/screenshot"] } as const;

/** A box the reporter drew over the screenshot, as fractions of its width and height. */
type Box = { x: number; y: number; w: number; h: number };

/** The kinds a person reports, which they name only where the agent could not read the sentence. */
type ReportKind = (typeof FEEDBACK_REPORT_KINDS)[number];

/** The project's data policy, `off` until its document is read or where it declares none. */
function useDataPolicy(projectId: string): SensitiveDataLevel {
  const doc = useProjectDocument(projectId).data;
  const v = doc?.declared ? doc.document.sensitiveData : undefined;
  return SENSITIVE_DATA_LEVELS.find((l) => l === v) ?? "off";
}

/** The screenshot with each box drawn black at its full size: what is sent, never the original. */
async function maskedBlob(blob: Blob, boxes: readonly Box[]): Promise<Blob> {
  if (boxes.length === 0) return blob;
  const image = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return blob;
  ctx.drawImage(image, 0, 0);
  // a cleared pixel has no colour left to read: a JPEG has no alpha, so the encoder composites it onto
  // opaque black (HTML canvas `toBlob`, serialising a bitmap to a file), and the hidden part is gone
  for (const b of boxes) ctx.clearRect(b.x * image.width, b.y * image.height, b.w * image.width, b.h * image.height);
  return new Promise((resolve) => canvas.toBlob((out) => resolve(out ?? blob), "image/jpeg", 0.85));
}

/** The screenshot, with drag-to-hide boxes the reporter draws over anything personal. */
function ScreenshotMask({ blob, boxes, onBoxes }: { blob: Blob; boxes: Box[]; onBoxes: (next: Box[]) => void }) {
  const t = useCopy();
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const frameRef = useRef<HTMLDivElement>(null);
  const [drawing, setDrawing] = useState<{ x: number; y: number; at: Box } | null>(null);
  const point = (e: PointerEvent) => {
    const r = frameRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return { x: 0, y: 0 };
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const shown = drawing ? [...boxes, drawing.at] : boxes;
  return (
    <div className="grid gap-1.5">
      <div
        ref={frameRef}
        className="relative cursor-crosshair touch-none select-none overflow-hidden rounded-sm border border-line"
        data-testid="report-screenshot"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = point(e);
          setDrawing({ ...p, at: { x: p.x, y: p.y, w: 0, h: 0 } });
        }}
        onPointerMove={(e) => {
          if (!drawing) return;
          const p = point(e);
          setDrawing({ ...drawing, at: { x: Math.min(p.x, drawing.x), y: Math.min(p.y, drawing.y), w: Math.abs(p.x - drawing.x), h: Math.abs(p.y - drawing.y) } });
        }}
        onPointerUp={() => {
          if (drawing && drawing.at.w > 0.005 && drawing.at.h > 0.005) onBoxes([...boxes, drawing.at]);
          setDrawing(null);
        }}
      >
        <img src={url} alt={t("feedback.report.shot")} className="block w-full" draggable={false} />
        {shown.map((b) => (
          <span
            key={`${b.x}:${b.y}:${b.w}:${b.h}`}
            className="absolute bg-black"
            data-testid="report-mask-box"
            style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-12 text-muted">
        <span>{t("feedback.report.hideHint")}</span>
        {boxes.length > 0 ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onBoxes(boxes.slice(0, -1))}>
            {t("feedback.report.undo")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ReportForm({
  project,
  shot,
  onShot,
  onFiled,
  onCancel,
}: {
  project: ProjectListItem;
  shot: Blob | null;
  onShot: (next: Blob | null) => void;
  onFiled: (filed: FeedbackReportResponse) => void;
  onCancel: () => void;
}) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const report = useReportFeedback(project.id);
  const submitting = useSubmitGuard();
  const level = useDataPolicy(project.id);
  const where = `${usePathname()}${useLocationSearch()}`;
  const [said, setSaid] = useState("");
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [redacted, setRedacted] = useState(false);
  const [kind, setKind] = useState<ReportKind | "">("");
  const refused = placeRefusals(report.error, FIELDS);
  const kindNeeded = kind !== "" || namedRefusals(report.error).some((r) => r.code === "FEEDBACK_KIND_NEEDED");
  const send = async () => {
    const screenshot = shot
      ? {
          name: "screenshot.jpg",
          mime: "image/jpeg",
          contentBase64: await base64Of(await maskedBlob(shot, boxes)),
          redacted: level === "redact" ? redacted : boxes.length > 0,
        }
      : undefined;
    report.mutate(
      { said: said.trim(), whereSeen: where, ...(kind ? { kind } : {}), ...(screenshot ? { screenshot } : {}) },
      { onSuccess: onFiled, onSettled: submitting.release },
    );
  };
  return (
    <form
      className="grid gap-3"
      data-testid="report-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!submitting.claim()) return;
        void send();
      }}
    >
      <Field label={t("feedback.report.said")} error={refused.at("said")} required>
        <Textarea value={said} onChange={(e) => setSaid(e.target.value)} rows={2} maxLength={FEEDBACK_LIMITS.title} ref={focusOnMount} />
      </Field>
      {kindNeeded ? (
        <Field label={t("feedback.report.kind")} error={refused.at("kind")} required>
          <NativeSelect
            value={kind}
            onChange={(e) => setKind(FEEDBACK_REPORT_KINDS.find((k) => k === e.target.value) ?? "")}
            options={[{ value: "", label: t("feedback.report.kindPick") }, ...FEEDBACK_REPORT_KINDS.map((k) => ({ value: k, label: enumLabel("feedbackKind", k, language) }))]}
          />
        </Field>
      ) : null}
      <Field label={t("feedback.report.shot")} error={refused.at("shot")}>
        {shot ? (
          <div className="grid gap-2">
            <ScreenshotMask blob={shot} boxes={boxes} onBoxes={setBoxes} />
            {level === "redact" ? <Checkbox checked={redacted} onChange={setRedacted} label={t("feedback.report.redacted")} /> : null}
            {level === "no_egress" ? <p className="text-12 text-muted">{t("feedback.report.agentsBlind")}</p> : null}
            <div>
              <Button type="button" variant="ghost" size="sm" icon="x" onClick={() => onShot(null)} data-testid="report-shot-remove">
                {t("feedback.report.remove")}
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-13 text-muted" data-testid="report-no-shot">
            {t("feedback.report.noShot")}
          </p>
        )}
      </Field>
      <RefusalLine error={report.error} onField={refused.onField} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={report.isPending}>
          {t("feedback.form.cancel")}
        </Button>
        <Button type="submit" variant="primary" size="sm" loading={report.isPending} disabled={!said.trim() || (kindNeeded && !kind)}>
          {t("feedback.report.send")}
        </Button>
      </div>
    </form>
  );
}

function ReportFiled({ filed, slug, onClose }: { filed: FeedbackReportResponse; slug: string; onClose: () => void }) {
  const t = useCopy();
  const key = filed.feedback.key;
  return (
    <div className="grid gap-3" data-testid="report-filed">
      <p className="text-13">{filed.created ? t("feedback.report.filed", { key }) : t("feedback.report.joined", { key })}</p>
      {filed.screenshot.state === "not_kept" ? (
        <p className="text-12 text-muted" data-testid="report-shot-not-kept">
          {t("feedback.report.shotNotKept", { key })}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Link href={feedbackHref(slug, key)} onClick={onClose} className="text-13 text-link hover:underline">
          {t("feedback.report.see", { key })}
        </Link>
        <Button type="button" variant="primary" size="sm" onClick={onClose}>
          {t("feedback.forge.done")}
        </Button>
      </div>
    </div>
  );
}

type About = "project" | "forge";

/** In a project: the report into it, or about Forge, with the page's screenshot taken as it opens. */
function ProjectFeedbackButton({ project, clientVersion }: { project: ProjectListItem; clientVersion?: string | undefined }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const [taking, setTaking] = useState(false);
  const [shot, setShot] = useState<Blob | null>(null);
  const [about, setAbout] = useState<About>("project");
  const [filed, setFiled] = useState<FeedbackReportResponse | null>(null);
  const [forgeFiled, setForgeFiled] = useState<ForgeFeedbackFiled | null>(null);
  const close = () => {
    setOpen(false);
    setShot(null);
    setFiled(null);
    setForgeFiled(null);
    setAbout("project");
  };
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        icon="mail"
        aria-label={t("feedback.report.open")}
        loading={taking}
        data-testid="feedback-open"
        data-capture-skip=""
        onClick={() => {
          setTaking(true);
          // the page as it stood before the dialog covers it
          void capturePage().then((blob) => {
            setShot(blob);
            setTaking(false);
            setOpen(true);
          });
        }}
      >
        <span className="max-sm:sr-only">{t("feedback.report.open")}</span>
      </Button>
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())} title={t("feedback.report.title")} testId="report-dialog">
        {filed ? (
          <ReportFiled filed={filed} slug={project.slug} onClose={close} />
        ) : forgeFiled ? (
          <ForgeFeedbackFiledNote filed={forgeFiled} onClose={close} />
        ) : open ? (
          <div className="grid gap-3">
            <SegmentedControl<About>
              options={[
                { value: "project", label: project.name },
                { value: "forge", label: t("feedback.report.aboutForge") },
              ]}
              value={about}
              onChange={setAbout}
            />
            {about === "project" ? (
              <ReportForm project={project} shot={shot} onShot={setShot} onFiled={setFiled} onCancel={close} />
            ) : (
              <ForgeFeedbackForm clientVersion={clientVersion} onFiled={setForgeFiled} onCancel={close} />
            )}
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

/** The shell's feedback entry on every page: about the project the page is in, or about Forge. */
export function FeedbackButton({ clientVersion }: { clientVersion?: string | undefined }) {
  const project = useCurrentProject();
  if (!project) return <ForgeFeedbackButton clientVersion={clientVersion} />;
  return <ProjectFeedbackButton project={project} clientVersion={clientVersion} />;
}
