// The Audit drawer's picture: open findings as a grid of layer by kind, each cell shaded by how many
// it holds (one hue, darker for more) and naming the places most of them sit on hover.

import { DEBT_KINDS, IMPACT_TYPES } from "@forge/contracts/cleanup";
import type { HomeAudit } from "@forge/contracts/project-home";
import { Tooltip } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";

export function AuditGrid({ audit }: { audit: HomeAudit }) {
  const t = useCopy();
  const cell = new Map(audit.cells.map((c) => [`${c.type}:${c.kind}`, c]));
  const types = IMPACT_TYPES.filter((ty) => audit.cells.some((c) => c.type === ty));
  const max = Math.max(1, ...audit.cells.map((c) => c.count));
  if (types.length === 0) return <p className="text-13 text-subtle">{t("home.audit.none")}</p>;
  return (
    <figure className="m-0" data-testid="home-audit-grid">
      <figcaption className="pb-2 text-12 text-subtle">{t("home.audit.where")}</figcaption>
      <div className="grid grid-cols-4 gap-1 text-12">
        <span />
        {DEBT_KINDS.map((k) => (
          <span key={k} className="text-center text-subtle">
            {t(`home.kind.${k}`)}
          </span>
        ))}
        {types.map((ty) => (
          <div key={ty} className="contents">
            <span className="self-center text-13 text-fg">{t(`home.layer.${ty}`)}</span>
            {DEBT_KINDS.map((k) => {
              const c = cell.get(`${ty}:${k}`);
              const n = c?.count ?? 0;
              const strength = n === 0 ? 0 : 12 + Math.round((76 * n) / max);
              const tip = c ? `${t(`home.layer.${ty}`)} · ${t(`home.kind.${k}`)}: ${c.places.map((p) => `${p.where} (${p.count})`).join(", ")}` : `${t(`home.layer.${ty}`)} · ${t(`home.kind.${k}`)}: 0`;
              return (
                <Tooltip key={k} label={tip} multiline focusable className="w-full">
                  <span
                    className="flex h-9 w-full items-center justify-center rounded-sm font-semibold tabular-nums"
                    style={{ background: `color-mix(in oklch, var(--chart-2) ${strength}%, var(--bg-sunken))`, color: strength > 55 ? "var(--fg-on-accent)" : "var(--fg-default)" }}
                    data-testid="home-audit-cell"
                  >
                    {n || ""}
                  </span>
                </Tooltip>
              );
            })}
          </div>
        ))}
      </div>
    </figure>
  );
}
