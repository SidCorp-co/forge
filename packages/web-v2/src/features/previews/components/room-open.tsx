"use client";

// Opening a POC room (REQ-44 BC-1) from a requirement, a feedback item or a chat offer: the first ask,
// then the room's page. `slug` and `canWrite` come from the page that mounts it; nothing above this
// feature is imported here.

import { PREVIEW_IDEA_LIMITS } from "@forge/contracts/preview";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Textarea } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { roomHref } from "@/lib/routes/rooms";
import { roomApi } from "../room-api";

export function OpenRoom({ projectId, slug, about, brief: initial = "", canWrite }: { projectId: string; slug: string | undefined; about: string; brief?: string; canWrite: boolean }) {
  const t = useCopy();
  const router = useRouter();
  const [brief, setBrief] = useState(initial);
  const open = useMutation({
    mutationFn: () => roomApi.open(projectId, { about, brief: brief.trim() }),
    onSuccess: (room) => {
      if (slug) router.push(roomHref(slug, room.id));
    },
  });
  if (!canWrite) return null;
  return (
    <form
      data-testid="open-room"
      data-about={about}
      className="grid gap-2"
      aria-label={t("previews.room.open")}
      onSubmit={(e) => {
        e.preventDefault();
        if (brief.trim()) open.mutate();
      }}
    >
      <Textarea aria-label={t("previews.room.openLabel")} value={brief} rows={2} maxLength={PREVIEW_IDEA_LIMITS.brief} placeholder={t("previews.room.openLabel")} onChange={(e) => setBrief(e.target.value)} />
      <div>
        <Button type="submit" size="sm" variant="secondary" disabled={brief.trim() === ""} loading={open.isPending}>
          {t("previews.room.open")}
        </Button>
      </div>
      {open.isError ? (
        <p role="alert" className="fg-caption text-danger">
          {t("previews.room.openFailed")}: {formatApiError(open.error)}
        </p>
      ) : null}
    </form>
  );
}
