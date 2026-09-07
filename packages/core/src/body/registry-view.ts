/**
 * Every projection of the registry that is not the registry itself: the JSON a
 * client renders an insert menu from, and the one text block the
 * `body-components` Forge Fact carries into every stage prompt.
 *
 * Both read the zod schemas the same way, and until ISS-967 they read them
 * twice — this file's own probe and a private one in `components.ts`. Two
 * readings of one schema is the drift ISS-968 removed from the prompt and this
 * one keeps out of the wire shape: `describeComponents` now renders the same
 * descriptors the endpoint serves.
 *
 * `public.ts`'s ISS-898 guard keeps the registry core-internal: web-v2 has no
 * dependency on `@forge/core` and gets only the descriptor types through
 * `@forge/contracts`. So the composer's insert menu — "put a `<forge-review>`
 * here, it needs `sha` and `verdict`" — has no way to learn the shape except
 * over the wire. This is that wire shape, derived from `SPECS` on every call.
 *
 * `components.ts` holds the registry and nothing else.
 */

import { z } from 'zod';
import { COMPONENT_NAMES, type ComponentSpec, specFor } from './components.js';

export interface BodyAttrDescriptor {
  name: string;
  required: boolean;
  /** The closed set, when the attribute is an enum. Absent for free strings. */
  values?: string[];
}

export interface BodySlotDescriptor {
  component: string;
  key: string;
  repeat: boolean;
  required: boolean;
}

export interface BodyComponentDescriptor {
  name: string;
  root: boolean;
  leaf: boolean;
  /** Content is raw text — a client must not treat it as markup. */
  raw: boolean;
  /** Declared slot order is enforced on write. */
  ordered: boolean;
  attrs: BodyAttrDescriptor[];
  slots: BodySlotDescriptor[];
}

interface ZodFieldDef {
  type: string;
  entries?: Record<string, string>;
  innerType?: z.ZodType;
}

// cm:guard walk `field.def` rather than probing with `safeParse` or `.options` — the enum's members live at `def.entries` and optionality at `def.type === 'optional'`, and those are the shapes the validator itself reads. A descriptor derived any other way is a second reading of one schema, which is the whole defect this module exists to prevent.
function describeAttr(name: string, field: z.ZodType): BodyAttrDescriptor {
  let def = field.def as ZodFieldDef;
  let required = true;
  if (def.type === 'optional' && def.innerType) {
    required = false;
    def = def.innerType.def as ZodFieldDef;
  }
  const values = def.type === 'enum' && def.entries ? Object.values(def.entries) : undefined;
  return values ? { name, required, values } : { name, required };
}

function describeAttrs(schema: z.ZodType): BodyAttrDescriptor[] {
  const shape = schema instanceof z.ZodObject ? schema.shape : {};
  return Object.entries(shape).map(([name, field]) => describeAttr(name, field as z.ZodType));
}

function describe(spec: ComponentSpec): BodyComponentDescriptor {
  return {
    name: spec.name,
    root: spec.root,
    leaf: spec.leaf === true,
    raw: spec.raw === true,
    ordered: spec.ordered === true,
    attrs: describeAttrs(spec.attrs),
    slots: spec.slots.map((s) => ({
      component: s.component,
      key: s.key,
      repeat: s.repeat === true,
      required: s.required === true,
    })),
  };
}

export function describeRegistry(): BodyComponentDescriptor[] {
  return COMPONENT_NAMES.map((name) => specFor(name))
    .filter((spec): spec is ComponentSpec => spec !== undefined)
    .map(describe);
}

/**
 * The component set as one text block, for the `body-components` Forge Fact
 * (`prompt/facts/registry.ts`) that every stage prompt carries.
 */
// cm:guard derive every line from the descriptors — a hand-written example here is a second copy of the registry, and the moment it disagrees the agent writes markup the kernel refuses with a 400 it cannot diagnose from the prompt it was given
export function describeComponents(): string {
  const all = describeRegistry();
  const line = (d: BodyComponentDescriptor) => {
    const attrs = d.attrs.map((a) => `${a.name}=${attrText(a)}`).join(' ');
    const slots = d.slots
      .map((s) => `${s.component}${s.repeat ? '*' : ''}${s.required ? '!' : ''}`)
      .join(' ');
    const parts = [attrs && `[${attrs}]`, slots && `{${slots}}`].filter(Boolean);
    return parts.length > 0 ? `${d.name} ${parts.join(' ')}` : d.name;
  };
  return [
    `Roots — ${all
      .filter((d) => d.root)
      .map(line)
      .join(' · ')}`,
    `Slots — ${all
      .filter((d) => !d.root)
      .map(line)
      .join(' · ')}`,
  ].join('\n');
}

function attrText(a: BodyAttrDescriptor): string {
  const base = a.values ? a.values.join('|') : 'string';
  return a.required ? base : `${base}?`;
}
