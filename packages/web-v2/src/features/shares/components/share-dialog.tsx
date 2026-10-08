"use client";

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
import Link from "next/link";
import { useState } from "react";
import { Button, EnumBadge, Field, Input, Radio, RadioGroup, SlideOver } from "@/design";
import { useTimeFormat } from "@/lib/i18n/interface-language";
import { useCreateShare, useShareAudiences } from "../hooks";
import type { ShareSubject } from "../subject";
import { ShareRefusal } from "./share-refusal";

const DAY_MS = 86_400_000;

const AUDIENCE_LABEL: Record<ShareAudience, string> = {
  members: "Project members",
  link: "Anyone with the link",
};

const AUDIENCE_HINT: Record<ShareAudience, string> = {
  members: "Opens only for someone signed in who can read this project.",
  link: "Opens for anyone holding the link, without signing in.",
};

const SUBJECT_TITLE: Record<ShareSubject["kind"], string> = {
  message: "Share this answer",
  "template-output": "Share this report",
  "status-report": "Share this status report",
};

const SUBJECT_LEAD: Record<ShareSubject["kind"], string> = {
  message: "A frozen copy of this answer's blocks and the runs they were read from, as you can read them now.",
  "template-output": "A frozen copy of this report's blocks and the runs they were read from, as you can read them now.",
  "status-report": "A frozen copy of this status report, as you can read it now.",
};

/** The days field read as a share's expiry, or the sentence saying what a valid one is. */
export function expiryOf(raw: string): { days: number } | { error: string } {
  const days = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(days) || days < 1) {
    return { error: `Choose a whole number of days, from 1 to ${SHARE_MAX_EXPIRY_DAYS}.` };
  }
  if (days > SHARE_MAX_EXPIRY_DAYS) {
    return { error: `A share expires within ${SHARE_MAX_EXPIRY_DAYS} days at most.` };
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

  const expiry = expiryOf(rawDays);
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
    <SlideOver open onClose={onClose} title={SUBJECT_TITLE[subject.kind]} width={460}>
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
          <p className="fg-body-sm text-muted">
            {SUBJECT_LEAD[subject.kind]} Secrets and email addresses are removed. Nothing else in the project
            can be reached from the link.
          </p>

          <fieldset className="flex flex-col gap-2.5">
            <legend className="fg-label mb-2">Who can open it</legend>
            <RadioGroup name="share-audience" value={audience} onChange={(v) => setAudience(v as ShareAudience)}>
              {(["members", "link"] as const).map((a) => {
                const refusal = refusalFor(options, a);
                const disabled = refusal !== null || (a === "link" && !linkOpen);
                return (
                  <div key={a} className="flex flex-col gap-0.5" data-testid={`share-audience-${a}`}>
                    <Radio value={a} label={AUDIENCE_LABEL[a]} disabled={disabled} />
                    <p className="fg-caption pl-7 text-subtle">{AUDIENCE_HINT[a]}</p>
                    {refusal && (
                      <p className="fg-caption pl-7 text-fg" data-testid={`share-audience-${a}-reason`} data-code={refusal.code}>
                        <span className="font-mono" translate="no">
                          {refusal.code}
                        </span>
                        : {refusal.message}
                      </p>
                    )}
                    {a === "link" && !options && audiencesQ.isLoading && (
                      <p className="fg-caption pl-7 text-subtle">Checking whether you can share outside the project…</p>
                    )}
                  </div>
                );
              })}
            </RadioGroup>
            {audiencesQ.isError && (
              <ShareRefusal error={audiencesQ.error} lead="Couldn't read which audiences you can share with, so only project members are offered" />
            )}
          </fieldset>

          <Field
            label="Expires after (days)"
            error={"error" in expiry ? expiry.error : undefined}
            hint={
              "days" in expiry
                ? `Expires ${time.date(Date.now() + expiry.days * DAY_MS)}. At most ${SHARE_MAX_EXPIRY_DAYS} days.`
                : undefined
            }
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

          {create.isError && <ShareRefusal error={create.error} lead="Core refused the share" />}

          <div className="flex justify-end gap-2.5">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!canCreate} loading={create.isPending}>
              Create link
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
      <p className="fg-body-sm text-fg">
        This link is shown once. Copy it now: Forge keeps only a fingerprint of it and cannot show it again.
      </p>
      <div className="flex items-center gap-2">
        <Input
          readOnly
          value={url}
          aria-label="Share link"
          data-testid="share-link"
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono"
        />
        <Button type="button" variant="primary" icon="link" onClick={doCopy}>
          {copy === "copied" ? "Copied" : "Copy link"}
        </Button>
      </div>
      {copy === "failed" && (
        <p className="fg-caption text-fg" role="status">
          Couldn't copy the link here. Select it and copy it by hand.
        </p>
      )}
      <p className="fg-caption flex flex-wrap items-center gap-1.5 text-muted">
        <EnumBadge family="shareAudience" value={share.audience} />
        <span>
          until <time dateTime={share.expiresAt} title={time.dateTime(share.expiresAt)}>{time.date(share.expiresAt)}</time>.
        </span>
        {manageHref ? (
          <span>
            Revoke it any time from{" "}
            <Link href={manageHref} className="underline underline-offset-2 hover:text-fg">
              the project's share links
            </Link>
            .
          </span>
        ) : (
          <span>Revoke it any time from the project's share links, under settings.</span>
        )}
      </p>
      <div className="flex justify-end">
        <Button type="button" variant="ghost" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}
