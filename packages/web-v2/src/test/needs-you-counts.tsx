import { useNeedsYou } from "@/features/needs-you/hooks";

/** The menu's waiting-on-you counts, mounted beside a form the way the shell mounts them, so a test sees the read every settled write starts again. */
export function NeedsYouCounts({ projectId }: { projectId: string }) {
  useNeedsYou(projectId);
  return null;
}
