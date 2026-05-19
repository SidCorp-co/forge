'use client';

import { useEffect, useRef, useState } from 'react';
import { useProject, useUpdateProject } from '@/features/project/hooks/use-projects';

interface Props {
  projectId: string;
  onSaved: () => void;
}

const BRANCH_RE = /^[a-zA-Z0-9._/-]{1,100}$/;

export function RepoStep({ projectId, onSaved }: Props) {
  const { data: project } = useProject(projectId);
  const updateProject = useUpdateProject();

  const [repoPath, setRepoPath] = useState('');
  const [baseBranch, setBaseBranch] = useState('main');
  const [productionBranch, setProductionBranch] = useState('main');
  const [error, setError] = useState<string | null>(null);

  // Seed the form once when the project loads. Using project.id as the dep
  // avoids re-seeding (and clobbering the user's typed value) every time the
  // query refetches and React Query hands back a new object reference.
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!project) return;
    if (seeded.current === project.id) return;
    seeded.current = project.id;
    setRepoPath(project.repoPath ?? '');
    setBaseBranch(project.baseBranch ?? 'main');
    setProductionBranch(project.productionBranch ?? 'main');
  }, [project]);

  const validate = (): string | null => {
    if (!repoPath.startsWith('/')) return 'Repository path must be absolute (start with "/").';
    if (!BRANCH_RE.test(baseBranch)) return 'Base branch contains invalid characters.';
    if (!BRANCH_RE.test(productionBranch)) return 'Production branch contains invalid characters.';
    return null;
  };

  const onSave = async () => {
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setError(null);
    try {
      await updateProject.mutateAsync({
        id: projectId,
        patch: { repoPath, baseBranch, productionBranch },
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save repository settings.');
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="repo-path" className="block text-sm font-medium text-on-surface-variant mb-1">
          Repository path
        </label>
        <input
          id="repo-path"
          type="text"
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
          placeholder="/home/you/projects/your-repo"
          className="w-full bg-transparent border-0 border-b border-outline/30 py-2 text-sm focus:outline-none focus:border-b-primary"
        />
        <p className="mt-1 text-[10px] text-outline">
          Absolute path on the device that will run agents.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="base-branch" className="block text-sm font-medium text-on-surface-variant mb-1">
            Base branch
          </label>
          <input
            id="base-branch"
            type="text"
            value={baseBranch}
            onChange={(e) => setBaseBranch(e.target.value)}
            className="w-full bg-transparent border-0 border-b border-outline/30 py-2 text-sm focus:outline-none focus:border-b-primary"
          />
        </div>
        <div>
          <label htmlFor="prod-branch" className="block text-sm font-medium text-on-surface-variant mb-1">
            Production branch
          </label>
          <input
            id="prod-branch"
            type="text"
            value={productionBranch}
            onChange={(e) => setProductionBranch(e.target.value)}
            className="w-full bg-transparent border-0 border-b border-outline/30 py-2 text-sm focus:outline-none focus:border-b-primary"
          />
        </div>
      </div>

      {error && (
        <p className="text-xs text-error" role="alert">
          {error}
        </p>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={updateProject.isPending}
          className="bg-primary text-on-primary px-4 py-2 text-sm rounded-sm disabled:opacity-50"
        >
          {updateProject.isPending ? 'Saving…' : 'Save repository'}
        </button>
      </div>
    </div>
  );
}
