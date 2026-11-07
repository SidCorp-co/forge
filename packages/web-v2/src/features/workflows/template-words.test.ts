// The built-in workflow templates read in English: every template, node type, band and line kind the
// contracts ship has its English word, and a project's own template keeps its author's words.

import { BUILTIN_WORKFLOW_TEMPLATES } from "@forge/contracts/workflow-templates";
import { describe, expect, it } from "vitest";
import { labelCopy } from "@/lib/i18n/labels";
import { PRODUCT_STRINGS as product } from "@/lib/i18n/product-copy";
import { builtinTemplateTitle, builtinTemplateWords } from "./template-words";

const en: Record<string, string> = product.en;
const named = (key: string, english: string) => {
  expect(en[key], `${key} has no en label`).toBe(english);
};

describe("the built-in workflow templates' words", () => {
  for (const t of BUILTIN_WORKFLOW_TEMPLATES) {
    it(`${t.id}: its title, node types, bands and line kinds have an en label`, () => {
      named(`label.templateTitle.${t.id}`, t.title);
      for (const n of t.nodeTypes) {
        named(`label.templateNode.${t.id}.${n.id}`, n.label);
        named(`label.templateNodeHint.${t.id}.${n.id}`, n.tooltip);
      }
      for (const b of t.lanes.from === "template" ? t.lanes.bands : []) named(`label.templateBand.${t.id}.${b.id}`, b.label);
      for (const k of t.edgeKinds) {
        named(`label.templateEdge.${t.id}.${k.id}`, k.label);
        named(`label.templateEdgeHint.${t.id}.${k.id}`, k.tooltip);
      }
    });
  }

  it("draws a built-in, keeps its ids, and reads it back unchanged", () => {
    const t = BUILTIN_WORKFLOW_TEMPLATES.find((x) => x.id === "state-machine");
    if (!t) throw new Error("the state machine template left the built-ins");
    const read = builtinTemplateWords(t, labelCopy("en"));
    expect(read.title).toBe(en["label.templateTitle.state-machine"]);
    expect(read.nodeTypes.map((n) => n.id)).toEqual(t.nodeTypes.map((n) => n.id));
    expect(read.nodeTypes.find((n) => n.id === "STATE")?.label).toBe(en["label.templateNode.state-machine.STATE"]);
    expect(builtinTemplateWords(t, labelCopy("en"))).toEqual(t);
    expect(builtinTemplateTitle("state-machine", labelCopy("en"))).toBe(read.title);
  });

  it("leaves a project's own template and any element no built-in names as written", () => {
    const base = BUILTIN_WORKFLOW_TEMPLATES[0];
    if (!base) throw new Error("no built-in template");
    const own = { ...base, id: "our-intake", title: "Our intake" };
    expect(builtinTemplateWords(own, labelCopy("en"))).toEqual(own);
    const first = base.nodeTypes.at(0);
    if (!first) throw new Error("the first built-in has no node types");
    const newer = { ...base, nodeTypes: [...base.nodeTypes, { ...first, id: "LATER", label: "Later" }] };
    expect(builtinTemplateWords(newer, labelCopy("en")).nodeTypes.at(-1)?.label).toBe("Later");
    expect(builtinTemplateTitle("our-intake", labelCopy("en"))).toBeNull();
  });
});
