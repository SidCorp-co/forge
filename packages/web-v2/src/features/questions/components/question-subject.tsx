// What a question is about, as core named it (`subject`): one line, its key opening the record's own
// page where the project is known, so the person answering never asks which requirement (ISS-583).

import type { QuestionSubject } from "@forge/contracts/questions";
import { useCopy } from "@/lib/i18n/interface-language";
import { Link } from "@/lib/navigation/router";
import { contractHref } from "@/lib/routes/contracts";
import { feedbackHref } from "@/lib/routes/feedback";
import { requirementHref } from "@/lib/routes/requirements";
import { cn } from "@/lib/utils/cn";

function hrefOf(subject: QuestionSubject, slug: string): string {
  if (subject.kind === "requirement") return requirementHref(slug, subject.key);
  if (subject.kind === "feedback") return feedbackHref(slug, subject.key);
  return contractHref(slug, subject.key);
}

export function QuestionSubjectLine({ subject, slug, className }: { subject: QuestionSubject; slug?: string | undefined; className?: string }) {
  const t = useCopy();
  const title = subject.kind === "contract" ? null : subject.title;
  return (
    <p className={cn("fg-body-sm text-fg", className)} data-testid="question-subject">
      <span className="text-muted">{t("agents.question.about")}</span>{" "}
      {slug ? (
        <Link href={hrefOf(subject, slug)} className="font-medium text-link hover:underline">
          {subject.key}
        </Link>
      ) : (
        <span className="font-medium">{subject.key}</span>
      )}
      {title ? <span className="text-muted"> · {title}</span> : null}
    </p>
  );
}
