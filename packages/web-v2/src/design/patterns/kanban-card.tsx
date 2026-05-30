import type { StageKey } from "@/design/stages";
import type { StatusKey, AvatarHue } from "@/design/status";
import { MonoTag } from "@/design/primitives/mono-tag";
import { Avatar } from "@/design/primitives/avatar";
import { Stat } from "@/design/primitives/stat";
import { PipelineTracker } from "./pipeline-tracker";

export interface KanbanCardProps {
  id: string;
  title: string;
  stage: StageKey;
  status: StatusKey;
  cost?: string;
  assignee?: { initials: string; hue?: AvatarHue };
  onClick?: () => void;
}

export function KanbanCard({ id, title, stage, status, cost, assignee, onClick }: KanbanCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full flex-col gap-2.5 rounded-md border border-line bg-surface p-3 text-left shadow-xs transition-colors duration-[120ms] hover:bg-hover"
    >
      <div className="flex items-center justify-between gap-2">
        <MonoTag>{id}</MonoTag>
        {assignee && <Avatar initials={assignee.initials} hue={assignee.hue} size={20} />}
      </div>
      <p className="fg-body-sm line-clamp-2 text-fg" style={{ fontWeight: 500 }}>
        {title}
      </p>
      <PipelineTracker stage={stage} status={status === "running" ? "running" : "queued"} variant="compact" />
      {cost && (
        <div className="flex items-center justify-between">
          <Stat icon="dollar">{cost}</Stat>
        </div>
      )}
    </button>
  );
}
