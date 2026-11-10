// One stage's drawer (REQ-43 BC-15): its figure, a picture of what it counts, and the way to the
// page that lists all of it. It slides over the home and Esc closes it; nothing on the home itself
// expands in place.

import type { ProjectHome } from "@forge/contracts/project-home";
import { SlideOver } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { Link } from "@/lib/navigation/router";
import { issuesHref } from "@/lib/routes/issues";
import { releasesListHref } from "@/lib/routes/releases";
import { requirementsHref } from "@/lib/routes/requirements";
import type { StageId } from "../model";
import { AuditGrid } from "./audit-grid";
import { DeliveryBoard } from "./delivery-board";
import { type StageView, StageBar } from "./loop";
import { ProductAreas } from "./product-areas";
import { ReleaseDrawerBody } from "./release-drawer";
import { Ring } from "./ring";

/** The page that lists all a stage counts. Debt lives on Activity, under the project's own peek. */
function fullPageOf(id: StageId, slug: string): string {
  if (id === "product") return requirementsHref(slug);
  if (id === "delivery") return issuesHref(slug);
  if (id === "release") return releasesListHref(slug);
  return `/activity?peek=${encodeURIComponent(slug)}`;
}

function Picture({ id, home, slug }: { id: StageId; home: ProjectHome; slug: string }) {
  if (id === "product") return <ProductAreas areas={home.product.areas} />;
  if (id === "delivery") return <DeliveryBoard delivery={home.delivery} slug={slug} />;
  if (id === "release") return <ReleaseDrawerBody stage={home.release} slug={slug} />;
  return <AuditGrid audit={home.audit} />;
}

export function StageDrawer({ stage, home, slug, onClose }: { stage: StageView | null; home: ProjectHome; slug: string; onClose: () => void }) {
  const t = useCopy();
  return (
    <SlideOver open={stage !== null} onClose={onClose} title={stage ? t(`home.stage.${stage.id}`) : ""} width={600}>
      {stage ? (
        <div className="flex min-h-full flex-col gap-5" data-testid={`home-drawer-${stage.id}`}>
          <div className="flex flex-col gap-2">
            <p className="m-0 flex items-center gap-3">
              {stage.ring !== null ? <Ring share={stage.ring} /> : null}
              <span className="text-24 font-semibold tabular-nums text-fg">{stage.big}</span>
              <span className="text-13 text-muted">{stage.unit}</span>
            </p>
            <StageBar parts={stage.parts} />
          </div>
          <Picture id={stage.id} home={home} slug={slug} />
          <Link href={fullPageOf(stage.id, slug)} className="mt-auto self-end text-13 font-semibold text-accent hover:underline" data-testid="home-drawer-full">
            {t(`home.open.${stage.id}`)} →
          </Link>
        </div>
      ) : null}
    </SlideOver>
  );
}
