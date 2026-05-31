import { ComingSoon } from "@/design";

/** `/projects/[slug]/pm` — the project PM surface isn't built yet. On-brand
 *  placeholder so the nav row never dead-ends on a hard 404. */
export default function ProjectPmPage() {
  return (
    <ComingSoon
      title="Project management"
      message="Planning, prioritisation, and roadmap tools for this project are on the way."
    />
  );
}
