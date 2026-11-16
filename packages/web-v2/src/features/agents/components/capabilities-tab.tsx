// Agents / Capabilities (ISS-1251 §7): every door Forge gives this project's agents, read at a glance
// first (calls, taught share, unused doors, piles over their cap, and calls against refusals per day),
// then what the project's prompts carry against their caps and what agents read, then the doors by
// where they stand. A door opens in a side drawer on its teaching, use, reports, lessons and card. The
// tab lives in the Agents screen (no new screen, design README "Screens").

import type { CapabilitiesView } from "@forge/contracts/capabilities";
import { DOOR_SURFACES } from "@forge/contracts/door-use";
import { CountSection, ExpandRow, ExpandRows, ListSearch, ListToolbar, SegmentedControl, StatusChip, useUrlChoice, useUrlParams } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";
import { CAP_STANDING_TONE, CAP_STANDINGS, type CapDoor, type CapStanding, capDoorsOf, doorTitle, standingCounts } from "../capabilities";
import { useCapabilityExtra, useDoorUse, usePiles } from "../hooks";
import { CapabilitiesBand } from "./capabilities-band";
import { CapabilityBudgets, CapabilityReading } from "./capabilities-budgets";
import { CapabilityDetail } from "./capability-detail";

const SURFACES = [...DOOR_SURFACES, "all"] as const;
type Surface = (typeof SURFACES)[number];
/** A group this long opens folded: its count reads first, its rows on demand. */
const OPEN_UP_TO = 50;

/** The chip a door's line carries: where it stands, why on hover. */
export function DoorStanding({ d }: { d: CapDoor }) {
  const t = useCopy();
  const s = d.standing;
  return <StatusChip tone={CAP_STANDING_TONE[s]} label={t(`agents.cap.chip.${s}`)} reason={t(`agents.cap.why.${s}`)} testId="cap-standing" />;
}

function DoorLine({ d }: { d: CapDoor }) {
  const t = useCopy();
  const title = doorTitle(d.row);
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
      <span className={cn("min-w-0 flex-1 truncate max-md:basis-full", title.mono && "font-mono text-12-5 text-fg")}>{title.text}</span>
      <span className="flex-none text-12 tabular-nums text-muted" data-testid="cap-calls-count">
        {t("agents.cap.calls", { n: d.row.calls })}
      </span>
      <DoorStanding d={d} />
    </span>
  );
}

/** The doors of one standing, one line each, each opening in a drawer. */
export function DoorGroup({ standing, doors }: { standing: CapStanding; doors: readonly CapDoor[] }) {
  const t = useCopy();
  const label = t(`agents.cap.standing.${standing}`);
  return (
    <CountSection label={label} count={doors.length} defaultOpen={doors.length <= OPEN_UP_TO} testId={`cap-group-${standing}`}>
      <ExpandRows label={label} className="-ml-7">
        {doors.map((d) => (
          <ExpandRow key={d.row.door} id={d.row.door} head={<DoorLine d={d} />} title={doorTitle(d.row).text} testId="cap-door" marks={{ "data-standing": d.standing }}>
            <CapabilityDetail d={d} />
          </ExpandRow>
        ))}
      </ExpandRows>
    </CountSection>
  );
}

function DoorList({ doors }: { doors: readonly CapDoor[] }) {
  const t = useCopy();
  const [surface, setSurface] = useUrlChoice<Surface>("surface", SURFACES, "mcp");
  const [params, setParams] = useUrlParams();
  const text = params.get("q") ?? "";
  const needle = text.trim().toLowerCase();
  const onSurface = doors.filter((d) => surface === "all" || d.row.surface === surface);
  const shown = onSurface.filter((d) => !needle || `${d.row.door} ${doorTitle(d.row).text} ${d.row.feature}`.toLowerCase().includes(needle));
  const count = (s: Surface) => doors.filter((d) => s === "all" || d.row.surface === s).length;
  return (
    <>
      <ListToolbar testId="cap-toolbar">
        <SegmentedControl options={SURFACES.map((s) => ({ value: s, label: t(`agents.cap.surface.${s}`), count: count(s) }))} value={surface} onChange={setSurface} />
        <ListSearch noun={t("agents.cap.noun")} value={text} onChange={(q) => setParams({ q: q || null })} />
      </ListToolbar>
      {shown.length === 0 ? <p className="px-5 py-6 text-13 text-muted">{t("agents.cap.empty")}</p> : null}
      <div className="px-5" aria-label={t("agents.cap.listLabel")}>
        {CAP_STANDINGS.map((s) => {
          const rows = shown.filter((d) => d.standing === s);
          return rows.length > 0 ? <DoorGroup key={s} standing={s} doors={rows} /> : null;
        })}
      </div>
    </>
  );
}

export function CapabilitiesTab({ projectId }: { projectId: string }) {
  const t = useCopy();
  const use = useDoorUse(projectId);
  const piles = usePiles(projectId).data;
  // the reports and card lessons refine where a door stands; the list never waits on them
  const extra: CapabilitiesView | undefined = useCapabilityExtra(projectId).data;
  return (
    <QueryBoundary query={use} loadingLabel={t("agents.cap.loading")} height="50vh" retry="always">
      {(u) => {
        const doors = capDoorsOf(u.doors, extra);
        return (
          <div className="grid min-h-full grid-cols-1 content-start bg-app" data-testid="capabilities-tab">
            <CapabilitiesBand use={u} counts={standingCounts(doors)} over={piles ? piles.piles.filter((p) => p.over).length : null} />
            <div className="px-5 py-2" aria-label={t("agents.cap.project")} data-testid="cap-project">
              {piles ? <CapabilityBudgets piles={piles} /> : null}
              <CapabilityReading use={u} />
            </div>
            <DoorList doors={doors} />
          </div>
        );
      }}
    </QueryBoundary>
  );
}
