import type { RepoConfig } from "@/lib/types";

interface RepoListProps {
  repos: RepoConfig[];
  onAdd: () => void;
  onUpdate: (idx: number, field: keyof RepoConfig, value: string) => void;
  onRemove: (idx: number) => void;
  onIndex: (repo: RepoConfig) => void;
  indexingRepo: string | null;
}

export function RepoList({ repos, onAdd, onUpdate, onRemove, onIndex, indexingRepo }: RepoListProps) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="text-sm text-gray-600">Repositories</label>
        <button
          onClick={onAdd}
          className="rounded bg-gray-100 px-3 py-1 text-xs text-gray-600 hover:bg-gray-200"
        >
          Add Repo
        </button>
      </div>
      {repos.length === 0 && (
        <p className="text-xs text-gray-400">No repositories configured.</p>
      )}
      <div className="space-y-2">
        {repos.map((repo, idx) => (
          <div
            key={idx}
            className="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3"
          >
            <div className="flex-1 space-y-2">
              <input
                type="text"
                value={repo.name}
                onChange={(e) => onUpdate(idx, "name", e.target.value)}
                placeholder="Name"
                className="w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm focus:border-blue-400 focus:outline-none"
              />
              <input
                type="text"
                value={repo.path}
                onChange={(e) => onUpdate(idx, "path", e.target.value)}
                placeholder="Path (e.g. /home/user/project)"
                className="w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm focus:border-blue-400 focus:outline-none"
              />
              <input
                type="text"
                value={repo.branch}
                onChange={(e) => onUpdate(idx, "branch", e.target.value)}
                placeholder="Branch (default: main)"
                className="w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm focus:border-blue-400 focus:outline-none"
              />
            </div>
            <div className="flex flex-col gap-1">
              <button
                onClick={() => onIndex(repo)}
                disabled={!repo.path || indexingRepo === repo.path}
                className="rounded bg-black px-3 py-1 text-xs text-white hover:bg-gray-800 disabled:opacity-40"
              >
                {indexingRepo === repo.path ? "Indexing..." : "Index"}
              </button>
              <button
                onClick={() => onRemove(idx)}
                className="rounded bg-red-50 px-3 py-1 text-xs text-red-500 hover:bg-red-100"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
