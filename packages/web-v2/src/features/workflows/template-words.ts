import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { LABEL_GROUPS, type LabelGroup } from "@/lib/i18n/labels";

// A built-in template drawn in the interface language: its title, node types, bands and line kinds
// read through the `template*` label groups, keyed by the contract's ids. The contract keeps its
// English; a project's own template is left as its author wrote it, and so is any element a
// built-in of another version names that this one does not.

type Label = (group: LabelGroup, value: string) => string;

/** `t` with its words in the language `label` reads, where `t` is a built-in the label groups hold. */
export function builtinTemplateWords(t: WorkflowTemplate, label: Label): WorkflowTemplate {
  const word = (group: LabelGroup, id: string, fallback: string): string => {
    const key = `${t.id}.${id}`;
    return key in LABEL_GROUPS[group] ? label(group, key) : fallback;
  };
  return {
    ...t,
    title: t.id in LABEL_GROUPS.templateTitle ? label("templateTitle", t.id) : t.title,
    nodeTypes: t.nodeTypes.map((n) => ({ ...n, label: word("templateNode", n.id, n.label), tooltip: word("templateNodeHint", n.id, n.tooltip) })),
    edgeKinds: t.edgeKinds.map((k) => ({ ...k, label: word("templateEdge", k.id, k.label), tooltip: word("templateEdgeHint", k.id, k.tooltip) })),
    lanes:
      t.lanes.from === "template"
        ? {
            ...t.lanes,
            bands: t.lanes.bands.map((b) => ({ ...b, label: word("templateBand", b.id, b.label), ...(b.tooltip ? { tooltip: word("templateBandHint", b.id, b.tooltip) } : {}) })),
          }
        : t.lanes,
  };
}

/** A built-in template's title in the interface language, by its id alone; null for an id no built-in has. */
export function builtinTemplateTitle(id: string, label: Label): string | null {
  return id in LABEL_GROUPS.templateTitle ? label("templateTitle", id) : null;
}
