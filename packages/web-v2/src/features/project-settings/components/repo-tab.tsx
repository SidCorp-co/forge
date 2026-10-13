"use client";

// Project settings → Repository. repoPath + baseBranch (where ISS-* branches are
// cut from), and the release chain — the ordered path code takes to live — all
// persisted via PATCH /api/projects/:id. The pipeline branches from these.
import { z } from "zod";
import {
  Button,
  Card,
  CardContent,
  Field,
  Input,
  SectionTitle,
  Select,
  type SelectOption,
  SettingsFormBar,
  useSettingsForm,
} from "@/design";
import type { ProjectDetail } from "@/features/projects/types";
import { useUpdateProject } from "../hooks";
import type { ProjectUpdateInput, ReleaseChainEntry, ReleaseCrossing } from "../types";

const CROSSINGS: SelectOption[] = [
  { value: "merge-branch", label: "merge-branch — merge the branch above into this one" },
  { value: "cherry-pick", label: "cherry-pick — copy chosen commits, giving them new shas" },
];

/** Every entry after the first. The first is always the base branch, so it is not edited twice. */
type Hop = { branch: string; from: ReleaseCrossing };

function hopsOf(chain: ReleaseChainEntry[]): Hop[] {
  return chain.slice(1).map((e) => ({ branch: e.branch, from: e.from ?? "merge-branch" }));
}

/** The tag pattern the project's live (last) entry names, which this screen shows no field for and so must hand back untouched. */
function tagOf(chain: ReleaseChainEntry[]): string | undefined {
  return chain[chain.length - 1]?.tag;
}

/** A chain as its meaning, not its key order: the server's jsonb hands entries back with their keys reordered. */
function chainKey(chain: ReleaseChainEntry[]): string {
  return JSON.stringify(chain.map((e) => [e.branch, e.from ?? null, e.tag ?? null]));
}

interface RepoDraft {
  repoPath: string;
  baseBranch: string;
  ships: boolean;
  hops: Hop[];
  releaseTag?: string;
}

const readOf = (project: ProjectDetail): RepoDraft => {
  const chain = (project.releaseChain ?? []) as ReleaseChainEntry[];
  return {
    repoPath: project.repoPath ?? "",
    baseBranch: project.baseBranch ?? "",
    ships: chain.length > 0,
    hops: hopsOf(chain),
    releaseTag: tagOf(chain),
  };
};

// Empty string → null (clears the column); a set value trims.
const norm = (v: string) => (v.trim() === "" ? null : v.trim());

/** The chain as it would be stored. Its first entry IS the base branch: a release that started
 *  anywhere else would deploy a branch work never lands on, which the API refuses by name. The tag
 *  belongs to the project's live entry, wherever that now is: dropping the last branch moves it to
 *  the new last one, and a project that ships nothing declares none. */
function chainOf(d: RepoDraft): ReleaseChainEntry[] {
  const base = norm(d.baseBranch);
  const entries: ReleaseChainEntry[] =
    !d.ships || base === null
      ? []
      : [
          { branch: base },
          ...d.hops
            .filter((h) => h.branch.trim() !== "")
            .map((h) => ({ branch: h.branch.trim(), from: h.from })),
        ];
  const last = entries.length - 1;
  return d.releaseTag === undefined || last < 0
    ? entries
    : entries.map((e, i) => (i === last ? { ...e, tag: d.releaseTag } : e));
}

const REPEATED =
  "The same branch appears twice, so the release would cross into a branch it has already left. That chain is refused — rename one of them, or remove it.";
const NO_BASE =
  "A release chain starts at the base branch, and this project names none. Fill in the base branch above before declaring a release.";

const schema: z.ZodType<RepoDraft, RepoDraft> = z
  .object({
    repoPath: z.string(),
    baseBranch: z.string(),
    ships: z.boolean(),
    hops: z.array(z.object({ branch: z.string(), from: z.enum(["merge-branch", "cherry-pick"]) })),
    releaseTag: z.string().optional(),
  })
  .superRefine((d, ctx) => {
    const chain = chainOf(d);
    if (new Set(chain.map((e) => e.branch)).size !== chain.length) {
      ctx.addIssue({ code: "custom", path: ["hops"], message: REPEATED });
    }
    if (d.ships && norm(d.baseBranch) === null) {
      ctx.addIssue({ code: "custom", path: ["ships"], message: NO_BASE });
    }
  });

export function RepoTab({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
  const update = useUpdateProject(project.id);
  const storedChain = (project.releaseChain ?? []) as ReleaseChainEntry[];
  const form = useSettingsForm<RepoDraft>({
    read: readOf(project),
    schema,
    comparable: (d) => ({
      repoPath: norm(d.repoPath),
      baseBranch: norm(d.baseBranch),
      chain: chainKey(chainOf(d)),
    }),
  });
  const { repoPath, baseBranch, ships, hops } = form.draft;
  const set = (next: Partial<RepoDraft>) => form.setDraft((d) => ({ ...d, ...next }));
  const setHops = (next: Hop[]) => set({ hops: next });

  const base = norm(baseBranch);
  const chain = chainOf(form.draft);
  const blankHop = ships && hops.some((h) => h.branch.trim() === "");

  async function save() {
    await form.save(async (held) => {
      const heldBase = norm(held.baseBranch);
      const heldChain = chainOf(held);
      const baseMoved = heldBase !== (project.baseBranch ?? null);
      const chainMoved = chainKey(heldChain) !== chainKey(storedChain);
      const patch: ProjectUpdateInput = {};
      if (norm(held.repoPath) !== (project.repoPath ?? null)) patch.repoPath = norm(held.repoPath);
      if (baseMoved) patch.baseBranch = heldBase;
      // A base branch that moves takes the chain's first entry with it, so the two go up together
      // rather than one of them arriving at a server that refuses the pair by name.
      if (chainMoved || (baseMoved && heldChain.length > 0)) patch.releaseChain = heldChain;
      if (Object.keys(patch).length > 0) await update.mutateAsync(patch);
    });
  }

  return (
    <>
    <Card>
      <CardContent>
        <SectionTitle className="fg-h3 mb-4">Repository</SectionTitle>
        <div className="space-y-4">
          <Field
            label="Repository path"
            hint="Absolute path on the runner host where the repo is checked out."
          >
            <Input
              value={repoPath}
              onChange={(e) => set({ repoPath: e.target.value })}
              disabled={!canEdit}
              placeholder="/home/runner/projects/my-repo"
              maxLength={500}
            />
          </Field>
          <Field
            label="Base branch"
            hint="Where ISS-* branches are cut from (e.g. main). It is not where a release goes."
          >
            <Input
              value={baseBranch}
              onChange={(e) => set({ baseBranch: e.target.value })}
              disabled={!canEdit}
              placeholder="main"
              maxLength={100}
            />
          </Field>

          <div className="space-y-3">
            <SectionTitle className="fg-h4">Release chain</SectionTitle>
            <p className="fg-caption text-subtle">
              The ordered path this project&apos;s code takes to live. It starts at the base branch;
              each branch after that says how the release crosses into it. Declare no branches and
              this project ships nothing — finishing the work is finishing it.
            </p>

            {ships ? (
              <>
                <ol className="space-y-3">
                  <li className="fg-body">
                    <span className="text-subtle">1.</span>{" "}
                    <strong>{base ?? "— name a base branch above —"}</strong>{" "}
                    <span className="text-subtle">— where work merges</span>
                  </li>
                  {hops.map((hop, i) => (
                    // A hop IS its position in the chain, and the half-typed branch name is not.
                    // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
                    <li key={i} className="space-y-2">
                      <Field label={`${i + 2}. Branch`} hint="Where the release lands at this step.">
                        <Input
                          value={hop.branch}
                          onChange={(e) =>
                            setHops(
                              hops.map((h, j) => (j === i ? { ...h, branch: e.target.value } : h)),
                            )
                          }
                          disabled={!canEdit}
                          placeholder="production"
                          maxLength={100}
                        />
                      </Field>
                      <Field
                        label="Crossed by"
                        hint="How the release gets from the branch above into this one."
                      >
                        <Select
                          options={CROSSINGS}
                          value={hop.from}
                          onChange={(v) =>
                            setHops(
                              hops.map((h, j) => (j === i ? { ...h, from: v as ReleaseCrossing } : h)),
                            )
                          }
                          disabled={!canEdit}
                        />
                      </Field>
                      {canEdit && (
                        <Button
                          variant="ghost"
                          onClick={() => setHops(hops.filter((_, j) => j !== i))}
                          className="min-h-11"
                        >
                          Remove {hop.branch.trim() === "" ? "this branch" : hop.branch}
                        </Button>
                      )}
                    </li>
                  ))}
                </ol>
                {canEdit && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => setHops([...hops, { branch: "", from: "merge-branch" }])}
                      className="min-h-11"
                    >
                      Add a branch
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => set({ ships: false, hops: [] })}
                      className="min-h-11"
                    >
                      This project ships nothing
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="fg-caption text-subtle">
                  This project ships nothing, so an issue closes when the work is done rather than
                  waiting for a release nobody would cut.
                </p>
                {canEdit && (
                  <Button variant="secondary" onClick={() => set({ ships: true })} className="min-h-11">
                    Declare a release
                  </Button>
                )}
              </>
            )}

            {form.errorAt("ships") && (
              <p className="fg-caption text-subtle">{form.errorAt("ships")}</p>
            )}
            {blankHop && (
              <p className="fg-caption text-subtle">
                A branch with no name is dropped when this is saved. Name it, or remove it.
              </p>
            )}
            {form.errorAt("hops") && (
              <p className="fg-caption text-subtle">{form.errorAt("hops")}</p>
            )}
            {chain.length > 1 && chain[0]?.branch === chain[1]?.branch && (
              <p className="fg-caption text-subtle">
                Base and live are the same branch, so every merge lands straight on the deployed
                branch — there is no buffer to catch a bad merge. Supported; just worth knowing.
              </p>
            )}
          </div>

        </div>
      </CardContent>
    </Card>
    {canEdit && (
      <SettingsFormBar
        dirty={form.dirty}
        saving={update.isPending}
        blockedBy={form.invalid ? "Fix what is noted above before saving." : null}
        onSave={() => void save().catch(() => undefined)}
        onDiscard={form.discard}
      />
    )}
    </>
  );
}
