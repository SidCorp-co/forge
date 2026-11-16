// The project's side of the capabilities page (ISS-1251 §7): each pile every prompt carries against
// its cap (the Tier-0 map per audience, the lessons map, always-on knowledge, each skill's always-on
// part), a pile over its cap marked "Over" for the steward to merge; and what agents read and applied,
// opened on demand in a drawer.

import type { DoorUseView, PileRow, PilesView } from "@forge/contracts/door-use";
import { CountSection, ProgressBar, RowItem, RowList, StatusChip } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { callerOf, pilesOf } from "../capabilities";

function usePileName() {
  const t = useCopy();
  return (p: PileRow): string => {
    if (p.pile === "skill_always_on") return p.name;
    if (p.pile === "tier0_map") {
      const audience = /\((bot|master|run)\)/.exec(p.name)?.[1] as "bot" | "master" | "run" | undefined;
      return audience ? t("modules.cap.pile.mapOf", { who: t(`modules.cap.caller.${audience}`) }) : t("modules.cap.pile.tier0_map");
    }
    return t(`modules.cap.pile.${p.pile}`);
  };
}

function PileLine({ p }: { p: PileRow }) {
  const t = useCopy();
  const name = usePileName()(p);
  return (
    <RowItem
      title={name}
      testId="cap-pile"
      rowKey={`${p.pile}:${p.name}`}
      facts={[t("modules.cap.pile.size", { size: p.size, cap: p.cap }), ...(p.carried < p.items ? [t("modules.cap.pile.carried", { n: p.carried, of: p.items })] : [])]}
      trailing={
        <>
          <ProgressBar value={p.cap > 0 ? (p.size / p.cap) * 100 : 0} tone={p.over ? "red" : "accent"} className="w-28" />
          {p.over ? <StatusChip tone="err" label={t("modules.cap.pile.over")} testId="cap-pile-over" /> : null}
        </>
      }
    />
  );
}

/** The piles, folded to one line with how many are over; each opens in a drawer with its size. */
export function CapabilityBudgets({ piles }: { piles: PilesView }) {
  const t = useCopy();
  const { prompt, skills } = pilesOf(piles.piles);
  const over = piles.piles.filter((p) => p.over).length;
  return (
    <CountSection label={t("modules.cap.budgets")} count={over} unit={t("modules.cap.pile.overUnit")} holds={piles.piles.length} drawer testId="cap-budgets">
      <RowList label={t("modules.cap.budgets")}>
        {prompt.map((p) => (
          <PileLine key={`${p.pile}:${p.name}`} p={p} />
        ))}
      </RowList>
      {skills.length > 0 ? (
        <>
          <h3 className="pt-4 pb-1 text-13 font-semibold text-fg">{t("modules.cap.pile.skills")}</h3>
          <RowList label={t("modules.cap.pile.skills")}>
            {skills.map((p) => (
              <PileLine key={p.name} p={p} />
            ))}
          </RowList>
        </>
      ) : null}
    </CountSection>
  );
}

export function CapabilityReading({ use }: { use: DoorUseView }) {
  const t = useCopy();
  const reaches = use.reads.reduce((n, r) => n + r.reaches, 0);
  const applied = use.lessonsApplied.reduce((n, r) => n + r.applications, 0);
  return (
    <>
      <CountSection label={t("modules.cap.read")} count={reaches} drawer testId="cap-reads">
        <RowList label={t("modules.cap.read")}>
          {use.reads.map((r) => (
            <RowItem
              key={`${r.agent}:${r.kind}:${r.how}`}
              title={`${t(`modules.cap.caller.${callerOf(r.agent)}`)} · ${t(`modules.cap.kind.${r.kind}`)}`}
              facts={[t(`modules.cap.how.${r.how}`), t("modules.cap.entries", { n: r.entries })]}
              trailing={<span className="text-13 tabular-nums text-fg">{r.reaches}</span>}
            />
          ))}
        </RowList>
      </CountSection>
      <CountSection label={t("modules.cap.applied")} count={applied} drawer testId="cap-applied">
        <RowList label={t("modules.cap.applied")}>
          {use.lessonsApplied.map((l) => (
            <RowItem
              key={`${l.lesson}:${l.agent}`}
              title={l.lesson}
              facts={[t(l.agent === "person" ? "modules.cap.person" : "modules.cap.agent")]}
              trailing={<span className="text-13 tabular-nums text-fg">{l.applications}</span>}
            />
          ))}
        </RowList>
      </CountSection>
    </>
  );
}
