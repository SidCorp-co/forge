// One door opened in its drawer (ISS-1251 §7): its teaching, who called it, its refusals by code, the
// reports agents filed on it, the lessons on its card, when the card last changed and its scenarios. A
// signal Forge does not record yet reads "Not yet", never 0, so a gap is never read as "none".

import { DOOR_REPORT_VERDICTS } from "@forge/contracts/door-use";
import { Fact, FactsEmpty, MonoTag, Section, StatusChip } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { CAP_CALLERS, type CapDoor, callsByCaller, codeWords } from "../capabilities";

function NotYet() {
  const t = useCopy();
  return <span className="text-subtle" data-testid="cap-not-yet">{t("modules.cap.notYet")}</span>;
}

function Teaching({ d }: { d: CapDoor }) {
  const t = useCopy();
  const card = d.row.card;
  if (!card) return <FactsEmpty>{t("modules.cap.noTeaching")}</FactsEmpty>;
  const inMap = card.audience.filter((a) => d.row.tiers[a] === 0);
  return (
    <div className="grid gap-2" data-testid="cap-teaching">
      <ul className="grid gap-1.5">
        {card.situations.map((s) => (
          <li key={s.when} className="text-13 text-fg">
            <span className="text-muted">{s.when}</span> → {s.do}
          </li>
        ))}
      </ul>
      <ul className="grid gap-1 text-13 text-muted">
        {card.practice.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      {card.redFlag ? <Fact label={t("modules.cap.redFlag")}>{card.redFlag}</Fact> : null}
      <Fact label={t("modules.cap.audience")}>{card.audience.map((a) => t(`modules.cap.caller.${a}`)).join(" · ")}</Fact>
      <Fact label={t("modules.cap.inMap")} testId="cap-in-map">
        {inMap.length > 0 ? inMap.map((a) => t(`modules.cap.caller.${a}`)).join(" · ") : t("modules.cap.bySituation")}
      </Fact>
    </div>
  );
}

function Calls({ d }: { d: CapDoor }) {
  const t = useCopy();
  const by = callsByCaller(d.row.byAgent);
  const codes = Object.entries(d.row.refusedBy ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <div className="grid" data-testid="cap-calls">
      {CAP_CALLERS.filter((c) => c !== "other" || by.other > 0).map((c) => (
        <Fact key={c} label={t(`modules.cap.caller.${c}`)}>
          <span className="tabular-nums">{by[c]}</span>
        </Fact>
      ))}
      <Fact label={t("modules.cap.refusals")}>
        {codes.length === 0 ? (
          <span className="tabular-nums">0</span>
        ) : (
          <span className="flex flex-wrap gap-x-3" data-testid="cap-refusal-codes">
            {codes.map(([code, n]) => (
              <span key={code} title={code}>
                {codeWords(code)} <span className="tabular-nums text-muted">{n}</span>
              </span>
            ))}
          </span>
        )}
      </Fact>
      <Fact label={t("modules.cap.misses")}>
        <NotYet />
      </Fact>
    </div>
  );
}

function Reports({ d }: { d: CapDoor }) {
  const t = useCopy();
  const f = d.feedback;
  if (!f) return <FactsEmpty>{t("modules.cap.noReports")}</FactsEmpty>;
  return (
    <div className="grid" data-testid="cap-reports">
      {DOOR_REPORT_VERDICTS.map((v) => (
        <Fact key={v} label={t(`modules.cap.verdict.${v}`)}>
          <span className="tabular-nums">{f.byVerdict[v] ?? 0}</span>
        </Fact>
      ))}
    </div>
  );
}

function Lessons({ d }: { d: CapDoor }) {
  const t = useCopy();
  const proposed = d.freshness?.proposed ?? [];
  if (d.lessons.length === 0 && proposed.length === 0) return <FactsEmpty>{t("modules.cap.noLessons")}</FactsEmpty>;
  return (
    <ul className="grid gap-2" data-testid="cap-lessons">
      {proposed.map((p) => (
        <li key={`${p.field}:${p.text}`} className="flex items-start gap-2 text-13 text-fg">
          <span className="min-w-0 flex-1">{p.text}</span>
          <StatusChip tone="run" label={t("modules.cap.lesson.folded")} />
        </li>
      ))}
      {d.lessons.map((l) => (
        <li key={l.number} className="flex items-start gap-2 text-13 text-fg">
          <span className="min-w-0 flex-1">{l.sentence}</span>
          {l.invalid ? (
            <StatusChip tone="blocked" label={t("modules.cap.lesson.invalid")} reason={l.invalidBy} />
          ) : (
            <StatusChip tone={l.status === "approved" ? "ready" : "neutral"} label={t(`modules.cap.lesson.${l.status}`)} reason={t("modules.cap.lesson.applied", { n: l.applied })} />
          )}
        </li>
      ))}
    </ul>
  );
}

function Scenarios({ d }: { d: CapDoor }) {
  const t = useCopy();
  const runs = d.freshness?.scenarios ?? [];
  if (runs.length > 0) {
    const passed = runs.filter((r) => r.passed).length;
    return <StatusChip tone={passed === runs.length ? "ready" : "err"} label={t("modules.cap.scenariosPass", { n: passed, total: runs.length })} reason={runs.filter((r) => !r.passed).map((r) => r.name).join(" · ") || null} />;
  }
  return <span className="text-subtle">{(d.row.card?.scenarios.length ?? 0) > 0 ? t("modules.cap.scenariosUnrun") : t("modules.cap.scenariosNone")}</span>;
}

function CardFreshness({ d }: { d: CapDoor }) {
  const t = useCopy();
  const time = useTimeFormat();
  const card = d.row.card;
  return (
    <div className="grid" data-testid="cap-card">
      <Fact label={t("modules.cap.changed")}>{card?.changed ? <span title={card.changed.by}>{time.date(card.changed.on)}</span> : <NotYet />}</Fact>
      <Fact label={t("modules.cap.recheck")} testId="cap-recheck">
        {d.freshness?.recheckOwed ? (
          <StatusChip tone="blocked" label={t("modules.cap.recheckSince", { date: time.date(d.freshness.recheckOwed.since) })} />
        ) : (
          t("modules.cap.recheckClear")
        )}
      </Fact>
      <Fact label={t("modules.cap.scenarios")} testId="cap-scenarios">
        <Scenarios d={d} />
      </Fact>
      <Fact label={t("modules.cap.door")}>
        <MonoTag>{d.row.door}</MonoTag>
      </Fact>
    </div>
  );
}

export function CapabilityDetail({ d }: { d: CapDoor }) {
  const t = useCopy();
  return (
    <div className="grid gap-1" data-testid="capability-detail">
      <Section title={t("modules.cap.part.teaching")}>
        <Teaching d={d} />
      </Section>
      <Section title={t("modules.cap.part.use")}>
        <Calls d={d} />
      </Section>
      <Section title={t("modules.cap.part.reports")}>
        <Reports d={d} />
      </Section>
      <Section title={t("modules.cap.part.lessons")}>
        <Lessons d={d} />
      </Section>
      <Section title={t("modules.cap.part.card")}>
        <CardFreshness d={d} />
      </Section>
    </div>
  );
}
