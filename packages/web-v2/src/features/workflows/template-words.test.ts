// The built-in workflow templates read in the interface language: every template, node type, band
// and line kind the contracts ship has its English and its Vietnamese word, and a project's own
// template keeps its author's words.

import { BUILTIN_WORKFLOW_TEMPLATES } from "@forge/contracts/workflow-templates";
import { describe, expect, it } from "vitest";
import { labelCopy } from "@/lib/i18n/labels";
import product from "@/lib/i18n/product-copy.json";
import { builtinTemplateTitle, builtinTemplateWords } from "./template-words";

const en = product.en as Record<string, string>;
const vi = product.vi as Record<string, string>;
const both = (key: string, english: string) => {
  expect(en[key], `${key} has no en label`).toBe(english);
  expect(vi[key], `${key} has no vi label`).toBeTruthy();
  expect(vi[key], `${key} reads in vi as its English`).not.toBe(english);
};

describe("the built-in workflow templates' words", () => {
  for (const t of BUILTIN_WORKFLOW_TEMPLATES) {
    it(`${t.id}: its title, node types, bands and line kinds have an en and a vi label`, () => {
      both(`label.templateTitle.${t.id}`, t.title);
      for (const n of t.nodeTypes) {
        both(`label.templateNode.${t.id}.${n.id}`, n.label);
        both(`label.templateNodeHint.${t.id}.${n.id}`, n.tooltip);
      }
      for (const b of t.lanes.from === "template" ? t.lanes.bands : []) both(`label.templateBand.${t.id}.${b.id}`, b.label);
      for (const k of t.edgeKinds) {
        both(`label.templateEdge.${t.id}.${k.id}`, k.label);
        both(`label.templateEdgeHint.${t.id}.${k.id}`, k.tooltip);
      }
    });
  }

  it("draws a built-in in vi, keeps its ids, and reads it back unchanged in en", () => {
    const t = BUILTIN_WORKFLOW_TEMPLATES.find((x) => x.id === "state-machine");
    if (!t) throw new Error("the state machine template left the built-ins");
    const read = builtinTemplateWords(t, labelCopy("vi"));
    expect(read.title).toBe(vi["label.templateTitle.state-machine"]);
    expect(read.nodeTypes.map((n) => n.id)).toEqual(t.nodeTypes.map((n) => n.id));
    expect(read.nodeTypes.find((n) => n.id === "STATE")?.label).toBe(vi["label.templateNode.state-machine.STATE"]);
    expect(builtinTemplateWords(t, labelCopy("en"))).toEqual(t);
    expect(builtinTemplateTitle("state-machine", labelCopy("vi"))).toBe(read.title);
  });

  it("leaves a project's own template and any element no built-in names as written", () => {
    const base = BUILTIN_WORKFLOW_TEMPLATES[0];
    if (!base) throw new Error("no built-in template");
    const own = { ...base, id: "our-intake", title: "Our intake" };
    expect(builtinTemplateWords(own, labelCopy("vi"))).toEqual(own);
    const newer = { ...base, nodeTypes: [...base.nodeTypes, { ...(base.nodeTypes[0] as (typeof base.nodeTypes)[number]), id: "LATER", label: "Later" }] };
    expect(builtinTemplateWords(newer, labelCopy("vi")).nodeTypes.at(-1)?.label).toBe("Later");
    expect(builtinTemplateTitle("our-intake", labelCopy("vi"))).toBeNull();
  });
});
