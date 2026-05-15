'use client';

import { Input, Label } from '@/components/ui';
import { useRepoForm } from '../hooks/use-repo-form';
import { useFocusOnMount } from '../hooks/use-focus-on-mount';
import { SectionSaveBar } from './section-save-bar';

interface Props {
  projectId: string;
}

export function RepoSection({ projectId }: Props) {
  const form = useRepoForm(projectId);
  useFocusOnMount();

  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">
          Repository
        </h2>
        <span className="text-[9px] font-mono text-outline">IDN_REP</span>
      </div>

      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-8">
        <div>
          <Label>Repository Path</Label>
          <div data-config-health-target="repo.repoPath">
            <Input
              type="text"
              value={form.state.repoPath}
              onChange={(e) => form.setField('repoPath', e.target.value)}
              placeholder="/home/user/projects/my-app"
              className="font-mono"
            />
          </div>
          <p className="mt-2 text-[10px] text-outline">Absolute path on desktop device.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
          <div>
            <Label>Base Branch</Label>
            <div data-config-health-target="repo.baseBranch">
              <Input
                type="text"
                value={form.state.baseBranch}
                onChange={(e) => form.setField('baseBranch', e.target.value)}
                placeholder="main"
                className="font-mono"
              />
            </div>
            <p className="mt-2 text-[10px] text-outline">Staging branch. Issues merge here for testing.</p>
          </div>
          <div>
            <Label>Production Branch</Label>
            <div data-config-health-target="repo.productionBranch">
              <Input
                type="text"
                value={form.state.productionBranch}
                onChange={(e) => form.setField('productionBranch', e.target.value)}
                placeholder="master"
                className="font-mono"
              />
            </div>
            <p className="mt-2 text-[10px] text-outline">Squash-merges here at release.</p>
          </div>
        </div>

        <SectionSaveBar
          isDirty={form.isDirty}
          isSubmitting={form.isSubmitting}
          isError={form.isError}
          isSuccess={form.isSuccess}
          onSave={() => void form.save()}
          onDiscard={form.reset}
        />
      </div>
    </section>
  );
}
