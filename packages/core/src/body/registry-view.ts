/**
 * The registry, projected to JSON for a client that has to OFFER a component
 * without being able to import one.
 *
 * `public.ts`'s ISS-898 guard keeps the registry core-internal: web-v2 has no
 * dependency on `@forge/core` and gets only the descriptor types through
 * `@forge/contracts`. So the composer's insert menu — "put a `<forge-review>`
 * here, it needs `sha` and `verdict`" — has no way to learn the shape except
 * over the wire. This is that wire shape, derived from `SPECS` on every call.
 *
 * It lives beside `components.ts` rather than inside it so the two files can
 * move independently; ISS-968 renders `{{forge:body-components}}` from that
 * one and the two changes must not collide.
 */

import type { z } from 'zod';
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

interface ZodShapeCarrier {
  shape?: Record<string, unknown>;
}

interface ZodFieldProbe {
  options?: readonly string[];
  safeParse?: (value: unknown) => { success: boolean };
  def?: { type?: string };
  unwrap?: () => ZodFieldProbe;
}

// cm:guard read the enum off `.options` and optionality off `safeParse(undefined)`. Both are the SAME probes `validate.ts:legalValues` and `refuseAttrs` already use, so the menu offers exactly what the 400 would accept — a hand-written mirror of any attribute here is the second list this endpoint exists to prevent.
function describeAttrs(schema: z.ZodType): BodyAttrDescriptor[] {
  const shape = (schema as unknown as ZodShapeCarrier).shape;
  if (!shape) return [];
  return Object.entries(shape).map(([name, raw]) => {
    const field = raw as ZodFieldProbe;
    const options = field.options ?? field.unwrap?.().options;
    const required = field.safeParse?.(undefined).success !== true;
    return options ? { name, required, values: [...options] } : { name, required };
  });
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
