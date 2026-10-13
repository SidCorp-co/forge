
// Creating a share link for one answer: who may open it, for how long, then the link, shown once.
// Which audience the person may pick is core's answer (`GET /api/projects/:id/shares/audiences`),
// read with the same checks creating a share makes, so a refused option carries core's own code and
// sentence and the screen never guesses at a permission or a data policy.

import {
  SHARE_DEFAULT_EXPIRY_DAYS,
  SHARE_MAX_EXPIRY_DAYS,
  type ShareAudience,
  type ShareAudienceOption,
  type ShareCreated,
} from "@forge/contracts/shares";
import { Link } from "@/lib/navigation/router";
import { useState } from "react";
import { Button, EnumBadge, Field, Input, Radio, RadioGroup, SlideOver, useNow } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { useCreateShare, useShareAudiences } from "../hooks";
import type { ShareSubject } from "../subject";
import { ShareRefusal } from "./share-refusal";

const DAY_MS = 86_400_000;

/** The days field read as a share's expiry, or the refusal saying what a valid one is. */
export function expiryOf(raw: string, t: Copy): { days: number } | { error: string } {
  const days = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(days) || days < 1) {
    return { error: t("shares.expiry.refused.whole", { max: SHARE_MAX_EXPIRY_DAYS }) };
  }
  if (days > SHARE_MAX_EXPIRY_DAYS) {
    return { error: t("shares.expiry.refused.max", { max: SHARE_MAX_EXPIRY_DAYS }) };
  }
  return { days };
}

function refusalFor(options: readonly ShareAudienceOption[] | undefined, audience: ShareAudience) {
  return options?.find((o) => o.audience === audience)?.refusal ?? null;
}

export function ShareDialog({
  projectId,
  subject,
  manageHref,
  onClose,
}: {
  projectId: string;
  subject: ShareSubject;
  /** Where this project's shares are listed and revoked, once the project's slug is known. */
  manageHref?: string | undefined;
  onClose: () => void;
}) {
  const audiencesQ = useShareAudiences(projectId, true);
  const create = useCreateShare(projectId);
  const [audience, setAudience] = useState<ShareAudience>("members");
  const [rawDays, setRawDays] = useState(String(SHARE_DEFAULT_EXPIRY_DAYS));
  const [created, setCreated] = useState<ShareCreated | null>(null);
  const time = useTimeFormat();
  const now = useNow(60_000);
  const t = useCopy();

  const expiry = expiryOf(rawDays, t);
  const options = audiencesQ.data;
  const pickedRefusal = refusalFor(options, audience);
  // the link option is offered only once core has answered that it is open to this person
  const linkOpen = Boolean(options) && refusalFor(options, "link") === null;
  const canCreate = "days" in expiry && pickedRefusal === null && (audience === "members" || linkOpen);

  const submit = () => {
    if (!("days" in expiry)) return;
    create.mutate(
      { subjectKind: subject.kind, subjectId: subject.id, audience, expiresInDays: expiry.days },
      { onSuccess: setCreated },
    );
  };

  return (
    <SlideOver open onClose={onClose} title={t(`shares.subject.${subject.kind}`)} width={460}>
      {created ? (
        <CreatedLink created={created} manageHref={manageHref} onClose={onClose} />
      ) : (
        <form
          className="flex flex-col gap-5"
          data-testid="share-dialog"
          onSubmit={(e) => {
            e.preventDefault();
            if (canCreate) submit();
          }}
        >
          <fieldset className="flex flex-col gap-2.5">
            <legend className="fg-label mb-2">{t("shares.dialog.audience")}</legend>
            <RadioGroup name="share-audience" value={audience} onChange={(v) => setAudience(v as ShareAudience)}>
              {(["members", "link"] as const).map((a) => {
                const refusal = refusalFor(options, a);
                const disabled = refusal !== null || (a === "link" && !linkOpen);
                return (
                  <div key={a} className="flex flex-col gap-0.5" data-testid={`share-audience-${a}`}>
                    <Radio value={a} label={t(`shares.audience.${a}`)} disabled={disabled} />
                    {refusal && (
                      <p className="fg-caption pl-7 text-fg" data-testid={`share-audience-${a}-reason`} data-code={refusal.code}>
                        <span className="font-mono" translate="no">
                          {refusal.code}
                        </span>
                        : {refusal.message}
                      </p>
                    )}
                    {a === "link" && !options && audiencesQ.isLoading && (
                      <p className="fg-caption pl-7 text-subtle">{t("shares.dialog.checking")}</p>
                    )}
                  </div>
                );
              })}
            </RadioGroup>
            {audiencesQ.isError && (
              <ShareRefusal error={audiencesQ.error} lead={t("shares.dialog.audiencesError")} />
            )}
          </fieldset>

          <Field
            label={t("shares.dialog.expires")}
            error={"error" in expiry ? expiry.error : undefined}
            hint={"days" in expiry ? t("shares.dialog.expiresOn", { date: time.date(now + expiry.days * DAY_MS) }) : undefined}
          >
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={SHARE_MAX_EXPIRY_DAYS}
              step={1}
              value={rawDays}
              onChange={(e) => setRawDays(e.target.value)}
              className="w-28"
            />
          </Field>

          {create.isError && <ShareRefusal error={create.error} lead={t("shares.dialog.refused")} />}

          <div className="flex justify-end gap-2.5">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("shares.dialog.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!canCreate} loading={create.isPending}>
              {t("shares.dialog.create")}
            </Button>
          </div>
        </form>
      )}
    </SlideOver>
  );
}

/** The link, the one time it exists outside the reader's hands. */
function CreatedLink({
  created,
  manageHref,
  onClose,
}: {
  created: ShareCreated;
  manageHref?: string | undefined;
  onClose: () => void;
}) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const time = useTimeFormat();
  const t = useCopy();
  const { share, url } = created;
  const doCopy = () => {
    if (!navigator.clipboard) {
      setCopy("failed");
      return;
    }
    navigator.clipboard.writeText(url).then(
      () => setCopy("copied"),
      () => setCopy("failed"),
    );
  };
  return (
    <div className="flex flex-col gap-4" data-testid="share-created">
      {share.title && (
        <p className="fg-body-sm font-semibold text-fg" data-testid="share-created-title">
          {share.title}
        </p>
      )}
      <p className="fg-body-sm text-fg">{t("shares.created.once")}</p>
      <div className="flex items-center gap-2">
        <Input
          readOnly
          value={url}
          aria-label={t("shares.created.link")}
          data-testid="share-link"
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono"
        />
        <Button type="button" variant="primary" icon="link" onClick={doCopy}>
          {copy === "copied" ? t("shares.created.copied") : t("shares.created.copy")}
        </Button>
      </div>
      {copy === "failed" && (
        <p className="fg-caption text-fg" role="status">
          {t("shares.created.copyFailed")}
        </p>
      )}
      <p className="fg-caption flex flex-wrap items-center gap-1.5 text-muted">
        <EnumBadge family="shareAudience" value={share.audience} />
        <span>
          {t("shares.created.until")} <time dateTime={share.expiresAt} title={time.dateTime(share.expiresAt)}>{time.date(share.expiresAt)}</time>
        </span>
        {manageHref && (
          <Link href={manageHref} className="underline underline-offset-2 hover:text-fg">
            {t("shares.created.manage")}
          </Link>
        )}
      </p>
      <div className="flex justify-end">
        <Button type="button" variant="ghost" onClick={onClose}>
          {t("shares.created.done")}
        </Button>
      </div>
    </div>
  );
}
