"use client";

// The one file that imports react-hook-form and its resolver. A page holds ONE form, its whole
// draft; a feature describes the draft and its zod schema and never sees the library.
//
// A re-read never takes the fresh document whole: the held edits ARE a patch, replayed over what is
// stored now. `takeStored` is the one exception, reached only by an act saying so.

import {
  buildDocumentPatch,
  canonicalJson,
  deepEqual,
  formatPath,
  parsePath,
  patchLeafPaths,
  rebaseDocumentDraft,
  type ReplacedEdit,
} from "@forge/contracts/document-patch";
import { zodResolver } from "@hookform/resolvers/zod";
import { useCallback, useEffect, useRef, useState } from "react";
import { type DefaultValues, type FieldValues, get, type Path, useForm, useWatch } from "react-hook-form";
import type { ZodType } from "zod";
import { useUnsavedChanges } from "./leave-guard";

export type { ReplacedEdit };

export interface SettingsFormOptions<T extends FieldValues> {
  /** The document as read, in the form's own shape. A read that differs by value is a re-read. */
  read: T;
  /** What the whole page may hold. Its refusals are named beside the field they are about. */
  schema?: ZodType<T, T>;
  /** Where a path of the stored document sits in the draft: the same path where omitted, null
   *  where the draft does not render it. */
  locate?: (path: readonly string[]) => string[] | null;
  /** The reverse, null where nowhere. */
  documentPathOf?: (path: readonly string[]) => string[] | null;
  /** The shape two drafts are compared in for `dirty`; the draft itself where omitted. */
  comparable?: (draft: T) => unknown;
  /** A number that changes each time a read lands, even one that read the same document. A page
   *  whose refusal offers `takeStored` passes it: the stored document may already be what the
   *  draft was seeded from, and the re-read that answers the request then differs in nothing. */
  readRevision?: number;
}

export interface SettingsForm<T> {
  draft: T;
  /** The draft as last seeded from the document: what a save is the difference from. */
  seeded: T;
  setDraft: (next: T | ((current: T) => T)) => void;
  dirty: boolean;
  invalid: boolean;
  /** What the schema says is wrong at this path of the draft (`previewUrls.0.url`), if anything. */
  errorAt: (path: string) => string | undefined;
  discard: () => void;
  /** Runs `write` with the draft when the schema accepts it: true once it has run, false where
   *  the draft was refused. What `write` throws is thrown on. */
  save: (write: (draft: T) => Promise<unknown> | unknown) => Promise<boolean>;
  /** Take the stored values at these document paths on the next read. The edits standing there
   *  are replaced — and come back in `replaced` — while the rest are kept. */
  takeStored: (paths: readonly string[]) => void;
  replaced: ReplacedEdit[];
  /** After a re-read that replaced edits: the document paths of the edits that were kept. */
  kept: string[];
  dismissReplaced: () => void;
}

interface Yielded {
  inside: string[];
  document: string;
}

/** Whether either path is the other's prefix — a yielded path meeting an edit made above it. */
function overlaps(a: readonly string[], b: readonly string[]): boolean {
  const shared = Math.min(a.length, b.length);
  for (let at = 0; at < shared; at += 1) if (a[at] !== b[at]) return false;
  return true;
}

export function useSettingsForm<T extends FieldValues>({
  read,
  schema,
  locate = (path) => [...path],
  documentPathOf = (path) => [...path],
  comparable = (draft) => draft,
  readRevision,
}: SettingsFormOptions<T>): SettingsForm<T> {
  const locateRef = useRef(locate);
  locateRef.current = locate;
  const documentPathRef = useRef(documentPathOf);
  documentPathRef.current = documentPathOf;
  const form = useForm<T>({
    defaultValues: read as DefaultValues<T>,
    resolver: schema ? zodResolver(schema as never) : undefined,
    mode: "onChange",
  });
  const draft = useWatch({ control: form.control }) as T;
  const { errors } = form.formState;

  // What the draft is compared against, and rebased from: the document as it was last taken.
  const seeded = useRef({ value: read, json: canonicalJson(read) });
  const yielding = useRef<Yielded[]>([]);
  const revision = useRef(readRevision);
  revision.current = readRevision;
  const askedAt = useRef<number | undefined>(undefined);
  const [replaced, setReplaced] = useState<ReplacedEdit[]>([]);
  const [kept, setKept] = useState<string[]>([]);
  const [, bump] = useState(0);

  const readJson = canonicalJson(read);
  useEffect(() => {
    const answersTake =
      yielding.current.length > 0 && readRevision !== undefined && readRevision !== askedAt.current;
    if (readJson === seeded.current.json && !answersTake) return;
    const taken = yielding.current;
    const rebased = rebaseDocumentDraft({
      read: seeded.current.value,
      held: form.getValues(),
      fresh: read,
      yielding: taken.map((one) => one.inside),
    });
    seeded.current = { value: read, json: readJson };
    yielding.current = [];
    form.reset(read as DefaultValues<T>);
    form.reset(rebased.draft as DefaultValues<T>, { keepDefaultValues: true });
    setReplaced(
      rebased.replaced.map((edit) => ({
        ...edit,
        path: taken.find((one) => overlaps(one.inside, parsePath(edit.path)))?.document ?? edit.path,
      })),
    );
    setKept(
      rebased.replaced.length === 0
        ? []
        : patchLeafPaths(buildDocumentPatch(read, rebased.draft).patch).flatMap((leaf) => {
            const at = documentPathRef.current(leaf);
            return at ? [formatPath(at)] : [];
          }),
    );
    bump((n) => n + 1);
    void form.trigger();
  }, [readJson, read, readRevision, form]);

  const setDraft = useCallback(
    (next: T | ((current: T) => T)) => {
      const current = form.getValues() as T;
      const target = typeof next === "function" ? (next as (c: T) => T)(current) : next;
      for (const key of new Set([...Object.keys(current), ...Object.keys(target)])) {
        if (!deepEqual(current[key], target[key])) {
          form.setValue(key as Path<T>, target[key], { shouldDirty: true });
        }
      }
      // Someone who has typed again is no longer waiting on the re-read they asked for.
      yielding.current = [];
      setReplaced([]);
      setKept([]);
      void form.trigger();
    },
    [form],
  );

  const takeStored = useCallback(
    (paths: readonly string[]) => {
      const taken: Yielded[] = [];
      for (const document of paths) {
        const inside = locateRef.current(parsePath(document));
        if (inside) taken.push({ inside, document });
      }
      yielding.current = taken;
      askedAt.current = revision.current;
      setReplaced([]);
    },
    [],
  );

  const discard = useCallback(() => {
    yielding.current = [];
    setReplaced([]);
    setKept([]);
    form.reset(seeded.current.value as DefaultValues<T>);
    void form.trigger();
  }, [form]);

  const save = useCallback(
    async (write: (draft: T) => Promise<unknown> | unknown): Promise<boolean> => {
      let ran = false;
      // The schema decides, and the draft it was handed is the one written: a parse may strip or
      // coerce, and what the person typed is what the page holds.
      await form.handleSubmit(async () => {
        ran = true;
        await write(form.getValues() as T);
      })();
      return ran;
    },
    [form],
  );

  const dirty = canonicalJson(comparable(draft)) !== canonicalJson(comparable(seeded.current.value));
  useUnsavedChanges(dirty);

  return {
    draft,
    seeded: seeded.current.value,
    setDraft,
    dirty,
    invalid: Object.keys(errors).length > 0,
    errorAt: (path) => {
      const found = get(errors, path) as { message?: unknown } | undefined;
      return typeof found?.message === "string" ? found.message : undefined;
    },
    discard,
    save,
    takeStored,
    replaced,
    kept,
    dismissReplaced: () => {
      setReplaced([]);
      setKept([]);
    },
  };
}
