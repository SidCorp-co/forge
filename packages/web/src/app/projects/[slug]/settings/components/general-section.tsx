'use client';

import { Input, Label, Textarea } from '@/components/ui';

interface GeneralSectionProps {
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  repoPath: string;
  setRepoPath: (v: string) => void;
  baseBranch: string;
  setBaseBranch: (v: string) => void;
  productionBranch: string;
  setProductionBranch: (v: string) => void;
}

export function GeneralSection({ name, setName, description, setDescription, repoPath, setRepoPath, baseBranch, setBaseBranch, productionBranch, setProductionBranch }: GeneralSectionProps) {
  return (
    <section className="space-y-6">
      {/* Section Header */}
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">01. General Identity</h2>
        <span className="text-[9px] font-mono text-outline">GEN_CFG_01</span>
      </div>

      {/* Identity Fields */}
      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
          <div>
            <Label>Project Name</Label>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <Label>Repository Path</Label>
            <Input
              type="text"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/home/user/projects/my-app"
              className="font-mono"
            />
            <p className="mt-2 text-[10px] text-outline">Absolute path on desktop device.</p>
          </div>
        </div>

        <div>
          <Label>Description</Label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
          <div>
            <Label>Base Branch</Label>
            <Input
              type="text"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              placeholder="main"
              className="font-mono"
            />
            <p className="mt-2 text-[10px] text-outline">Staging branch. Issues merge here for testing.</p>
          </div>
          <div>
            <Label>Production Branch</Label>
            <Input
              type="text"
              value={productionBranch}
              onChange={(e) => setProductionBranch(e.target.value)}
              placeholder="master"
              className="font-mono"
            />
            <p className="mt-2 text-[10px] text-outline">Squash-merges here at release.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
