import { ComingSoon } from "@/design";

/** `/activity` — feature not built yet (tracked in ISS-296). On-brand
 *  placeholder so the nav row never dead-ends on a hard 404. */
export default function ActivityPage() {
  return (
    <ComingSoon
      title="Activity"
      message="A unified feed of pipeline runs, deploys, and agent events is on the way."
    />
  );
}
