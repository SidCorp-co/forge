"use client";

import { useParams } from "next/navigation";
import { ProjectRefGate } from "@/features/projects/components/project-gate";
import { RoomScreen } from "@/features/previews";
import { useCopy } from "@/lib/i18n/interface-language";

export default function ProjectRoomPage() {
  const t = useCopy();
  const params = useParams<{ slug: string; room: string }>();
  return <ProjectRefGate label={t("previews.room.loading")}>{(p) => <RoomScreen roomId={decodeURIComponent(params.room)} slug={p.slug} />}</ProjectRefGate>;
}
