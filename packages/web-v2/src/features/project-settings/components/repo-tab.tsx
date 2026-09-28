"use client";

// Project settings → Repository. repoPath + baseBranch (where ISS-* branches are
// cut from), and the release chain — the ordered path code takes to live — all
// persisted via PATCH /api/projects/:id. The pipeline branches from these.
import { useEffect, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  Field,
  Input,
  SectionTitle,
  Select,
  type SelectOption,
} from "@/design";
import type { ProjectDetail } from "@/features/projects/types";
import { useUpdateProject } from "../hooks";
import type { ReleaseChainEntry, ReleaseCrossing } from "../types";

const CROSSINGS: SelectOption[] = [
  { value: "merge-branch", label: "merge-branch — merge the branch above into this one" },
  { value: "cherry-pick", label: "cherry-pick — copy chosen commits, giving them new shas" },
];

/** Every entry after the first. The first is always the base branch, so it is not edited twice. */
type Hop = { branch: string; from: ReleaseCrossing };

function hopsOf(chain: ReleaseChainEntry[]): Hop[] {
  return chain.slice(1).map((e) => ({ branch: e.branch, from: e.from ?? "merge-branch" }));
}

export function RepoTab({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
  const update = useUpdateProject(project.id);
  const storedChain = (project.releaseChain ?? []) as ReleaseChainEntry[];

  const [repoPath, setRepoPath] = useState(project.repoPath ?? "");
  const [baseBranch, setBaseBranch] = useState(project.baseBranch ?? "");
  const [ships, setShips] = useState(storedChain.length > 0);
  const [hops, setHops] = useState<Hop[]>(hopsOf(storedChain));

  useEffect(() => {
    setRepoPath(project.repoPath ?? "");
    setBaseBranch(project.baseBranch ?? "");
    const chain = (project.releaseChain ?? []) as ReleaseChainEntry[];
    setShips(chain.length > 0);
    setHops(hopsOf(chain));
  }, [project.repoPath, project.baseBranch, project.releaseChain]);

  // Empty string → null (clears the column); a set value trims.
  const norm = (v: string) => (v.trim() === "" ? null : v.trim());
  const base = norm(baseBranch);

  // The chain as it would be stored. Its first entry IS the base branch: a release that started
  // anywhere else would deploy a branch work never lands on, which the API refuses by name.
  const chain: ReleaseChainEntry[] =
    !ships || base === null
      ? []
      : [
          { branch: base },
          ...hops
            .filter((h) => h.branch.trim() !== "")
            .map((h) => ({ branch: h.branch.trim(), from: h.from })),
        ];

  const chainMoved = JSON.stringify(chain) !== JSON.stringify(storedChain);
  const baseMoved = base !== (project.baseBranch ?? null);
  const dirty = norm(repoPath) !== (project.repoPath ?? null) || baseMoved || chainMoved;

  const repeated = new Set(chain.map((e) => e.branch)).size !== chain.length;
  const blankHop = ships && hops.some((h) => h.branch.trim() === "");
  const shipsWithoutBase = ships && base === null;

  function save() {
    const patch: Record<string, unknown> = {};
    if (norm(repoPath) !== (project.repoPath ?? null)) patch.repoPath = norm(repoPath);
    if (baseMoved) patch.baseBranch = base;
    // A base branch that moves takes the chain's first entry with it, so the two go up together
    // rather than one of them arriving at a server that refuses the pair by name.
    if (chainMoved || (baseMoved && chain.length > 0)) patch.releaseChain = chain;
    if (Object.keys(patch).length > 0) update.mutate(patch);
  }

  return (
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
              onChange={(e) => setRepoPath(e.target.value)}
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
              onChange={(e) => setBaseBranch(e.target.value)}
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
                      onClick={() => {
                        setShips(false);
                        setHops([]);
                      }}
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
                  <Button variant="secondary" onClick={() => setShips(true)} className="min-h-11">
                    Declare a release
                  </Button>
                )}
              </>
            )}

            {shipsWithoutBase && (
              <p className="fg-caption text-subtle">
                A release chain starts at the base branch, and this project names none. Fill in the
                base branch above before declaring a release.
              </p>
            )}
            {blankHop && (
              <p className="fg-caption text-subtle">
                A branch with no name is dropped when this is saved. Name it, or remove it.
              </p>
            )}
            {repeated && (
              <p className="fg-caption text-subtle">
                The same branch appears twice, so the release would cross into a branch it has
                already left. That chain is refused — rename one of them, or remove it.
              </p>
            )}
            {chain.length > 1 && chain[0]?.branch === chain[1]?.branch && (
              <p className="fg-caption text-subtle">
                Base and live are the same branch, so every merge lands straight on the deployed
                branch — there is no buffer to catch a bad merge. Supported; just worth knowing.
              </p>
            )}
          </div>

          {canEdit && (
            <div>
              <Button
                variant="primary"
                loading={update.isPending}
                disabled={!dirty || repeated || shipsWithoutBase}
                onClick={save}
                className="min-h-11"
              >
                Save repository
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
