"use client";

import { type Refusal, readRefusal } from "@/lib/api/refusals";
import { useCopy } from "@/lib/i18n/interface-language";

/** A refused write or read, shown with the code core named it by. Never a toast, never nothing. */
export function RefusalNotice({ refusals, title }: { refusals: Refusal[]; title?: string }) {
  const t = useCopy();
  if (refusals.length === 0) return null;
  return (
    <div
      role="alert"
      className="rounded-md border px-3 py-2 text-13"
      style={{ borderColor: "var(--red-500)", background: "var(--red-50)", color: "var(--red-600)" }}
    >
      <p className="font-medium">{t("ecosystem.notice.refused", { title: title ?? t("ecosystem.notice.refusedTitle") })}</p>
      <ul className="mt-1 space-y-1">
        {refusals.map((r) => {
          const read = readRefusal(r);
          return (
            <li key={`${r.code}${r.path}${r.detail}`} className="break-words">
              <code className="font-mono text-12">{read.code}</code>
              {read.where ? <span> · {read.where}</span> : null}
              <span className="text-fg"> — {read.sentence}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A read that failed. It says the thing could not be read and why; it never reads as empty. */
export function UnreadNotice({ what, refusals }: { what: string; refusals: Refusal[] }) {
  const t = useCopy();
  return (
    <div
      role="alert"
      className="rounded-md border px-3 py-2 text-13"
      style={{ borderColor: "var(--amber-50)", background: "var(--amberw-50)", color: "var(--amberw-600)" }}
    >
      <p className="font-medium">{t("ecosystem.notice.unread", { what })}</p>
      <ul className="mt-1 space-y-1">
        {refusals.map((r) => (
          <li key={`${r.code}${r.path}${r.detail}`} className="break-words">
            <code className="font-mono text-12">{r.code}</code>
            <span className="text-fg"> — {r.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ReadOnlyNotice({ role, slug, writes }: { role: string | null; slug: string; writes: string }) {
  return (
    <p className="fg-caption">
      You are {role ? `a ${role}` : "not a member"} on {slug}, so you read its channel and write nothing in it; a member or admin {writes}.
    </p>
  );
}

export function Loading({ what }: { what: string }) {
  const t = useCopy();
  return <p className="fg-caption py-2">{t("ecosystem.notice.loading", { what })}</p>;
}
