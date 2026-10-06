import { fullFormats } from 'ajv-formats/dist/formats.js';
import { RE2JS } from 're2js';

// a provider's pattern runs on RE2's automaton, which matches in time linear in the input, so no pattern a provider writes can backtrack core into a stall
class LinearRegExp {
  readonly #re: RE2JS;
  readonly #label: string;
  constructor(pattern: string, flags: string) {
    this.#re = RE2JS.compile(pattern, flags.includes('i') ? RE2JS.CASE_INSENSITIVE : 0);
    this.#label = `/${pattern}/${flags}`;
  }
  test(input: string): boolean {
    return this.#re.matcher(input).find();
  }
  toString(): string {
    return this.#label;
  }
}

export const linearRegExp = Object.assign(
  (pattern: string, flags = '') => new LinearRegExp(pattern, flags),
  { code: 'linearRegExp' },
);

function unsafePattern(pattern: string): string | null {
  try {
    RE2JS.compile(pattern);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const esc = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');

const DATA_KEYWORDS = new Set(['enum', 'const', 'default', 'examples', 'example']);

interface UnsafePattern {
  path: string;
  pattern: string;
  why: string;
}

export function unsafePatterns(schema: unknown, at = ''): UnsafePattern[] {
  if (Array.isArray(schema)) return schema.flatMap((s, i) => unsafePatterns(s, `${at}/${i}`));
  if (!isObject(schema)) return [];
  const out: UnsafePattern[] = [];
  if (typeof schema.pattern === 'string') {
    const why = unsafePattern(schema.pattern);
    if (why) out.push({ path: `${at}/pattern`, pattern: schema.pattern, why });
  }
  if (isObject(schema.patternProperties)) {
    for (const p of Object.keys(schema.patternProperties)) {
      const why = unsafePattern(p);
      if (why) out.push({ path: `${at}/patternProperties/${esc(p)}`, pattern: p, why });
    }
  }
  for (const [k, v] of Object.entries(schema)) {
    if (!DATA_KEYWORDS.has(k)) out.push(...unsafePatterns(v, `${at}/${esc(k)}`));
  }
  return out;
}

const FORMAT_MAX_LENGTH = 4096;

type FormatCheck = (s: string) => boolean;
type Format = FormatCheck | true | (Record<string, unknown> & { validate: FormatCheck });

const bounded =
  (inner: FormatCheck): FormatCheck =>
  (s) =>
    typeof s === 'string' ? s.length <= FORMAT_MAX_LENGTH && inner(s) : inner(s);

function linearOrNative(re: RegExp): FormatCheck {
  if (unsafePattern(re.source)) return (s) => re.test(s);
  const linear = new LinearRegExp(re.source, re.flags);
  return (s) => linear.test(s);
}

// ajv-formats is core's own vocabulary, but three of its expressions use lookahead RE2 cannot hold; each format runs on RE2 where RE2 can, and every format is held to a bounded string before it runs, so an expression that stays native is never fed one long enough to stall
function boundedFormat(def: unknown): Format | null {
  if (def === true) return true;
  if (def instanceof RegExp) return bounded(linearOrNative(def));
  if (typeof def === 'function') return bounded(def as FormatCheck);
  if (!isObject(def)) return null;
  const v = def.validate;
  if (v instanceof RegExp) return { ...def, validate: bounded(linearOrNative(v)) };
  if (typeof v === 'function') return { ...def, validate: bounded(v as FormatCheck) };
  return null;
}

export function boundedFormats(): Record<string, Format> {
  const out: Record<string, Format> = {};
  for (const [name, def] of Object.entries(fullFormats)) {
    const f = boundedFormat(def);
    if (!f)
      throw new Error(
        `safe-regex: ajv-formats format ${name} has a shape this wrapper does not know`,
      );
    out[name] = f;
  }
  return out;
}
