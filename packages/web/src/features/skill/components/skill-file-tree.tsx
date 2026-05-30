'use client';

import { useMemo } from 'react';
import { FileText, FilePlus, FolderPlus, Pencil, Trash2, Folder } from 'lucide-react';
import type { SkillFile } from '../types';

/** SKILL.md is pinned at the root and is neither renamable nor deletable. */
export const SKILL_MD_PATH = 'SKILL.md';

interface SkillFileTreeProps {
  files: SkillFile[];
  selectedPath: string;
  onSelectPath: (path: string) => void;
  /** Emits the next files[] array after an add/rename/delete (file or folder). */
  onFilesChange: (files: SkillFile[]) => void;
  readOnly?: boolean;
}

interface TreeGroup {
  /** Folder name (first path segment) or '' for root-level files. */
  folder: string;
  files: SkillFile[];
}

function sanitizePath(raw: string): string {
  return raw
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '');
}

function groupFiles(files: SkillFile[]): TreeGroup[] {
  const groups = new Map<string, SkillFile[]>();
  for (const f of files) {
    const slash = f.path.indexOf('/');
    const folder = slash === -1 ? '' : f.path.slice(0, slash);
    const arr = groups.get(folder) ?? [];
    arr.push(f);
    groups.set(folder, arr);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => {
      if (a === '') return -1; // root files first
      if (b === '') return 1;
      return a.localeCompare(b);
    })
    .map(([folder, fs]) => ({
      folder,
      files: fs.slice().sort((x, y) => x.path.localeCompare(y.path)),
    }));
}

export function SkillFileTree({
  files,
  selectedPath,
  onSelectPath,
  onFilesChange,
  readOnly,
}: SkillFileTreeProps) {
  const groups = useMemo(() => groupFiles(files), [files]);

  function addFile(folderPrefix = '') {
    const input = window.prompt(
      folderPrefix ? `New file in ${folderPrefix}/ (name):` : 'New file path (e.g. references/guide.md):',
    );
    if (!input) return;
    const path = sanitizePath(folderPrefix ? `${folderPrefix}/${input}` : input);
    if (!path || path === SKILL_MD_PATH) return;
    if (files.some((f) => f.path === path)) {
      window.alert(`A file at "${path}" already exists.`);
      return;
    }
    onFilesChange([...files, { path, content: '', encoding: 'utf8' }]);
    onSelectPath(path);
  }

  function addFolder() {
    const input = window.prompt('New folder name (e.g. references):');
    if (!input) return;
    const folder = sanitizePath(input);
    if (!folder) return;
    // Folders only exist as path prefixes — seed one placeholder file so the
    // folder is visible and persists in files[].
    const placeholder = `${folder}/untitled.md`;
    if (files.some((f) => f.path === placeholder)) {
      onSelectPath(placeholder);
      return;
    }
    onFilesChange([...files, { path: placeholder, content: '', encoding: 'utf8' }]);
    onSelectPath(placeholder);
  }

  function renameFile(file: SkillFile) {
    const input = window.prompt('Rename file to:', file.path);
    if (!input) return;
    const next = sanitizePath(input);
    if (!next || next === file.path) return;
    if (next === SKILL_MD_PATH || files.some((f) => f.path === next)) {
      window.alert(`Cannot rename to "${next}" — name is reserved or already in use.`);
      return;
    }
    onFilesChange(files.map((f) => (f.path === file.path ? { ...f, path: next } : f)));
    if (selectedPath === file.path) onSelectPath(next);
  }

  function deleteFile(file: SkillFile) {
    if (!window.confirm(`Delete "${file.path}"?`)) return;
    onFilesChange(files.filter((f) => f.path !== file.path));
    if (selectedPath === file.path) onSelectPath(SKILL_MD_PATH);
  }

  function renameFolder(folder: string) {
    const input = window.prompt(`Rename folder "${folder}" to:`, folder);
    if (!input) return;
    const next = sanitizePath(input);
    if (!next || next === folder) return;
    const collides = files.some(
      (f) => f.path === next || f.path.startsWith(`${next}/`),
    );
    if (collides) {
      window.alert(`Cannot rename — "${next}" already exists.`);
      return;
    }
    const prefix = `${folder}/`;
    let nextSelected = selectedPath;
    const updated = files.map((f) => {
      if (f.path.startsWith(prefix)) {
        const np = `${next}/${f.path.slice(prefix.length)}`;
        if (f.path === selectedPath) nextSelected = np;
        return { ...f, path: np };
      }
      return f;
    });
    onFilesChange(updated);
    if (nextSelected !== selectedPath) onSelectPath(nextSelected);
  }

  function deleteFolder(folder: string) {
    if (!window.confirm(`Delete folder "${folder}/" and all files in it?`)) return;
    const prefix = `${folder}/`;
    const removedSelected = selectedPath.startsWith(prefix);
    onFilesChange(files.filter((f) => !f.path.startsWith(prefix)));
    if (removedSelected) onSelectPath(SKILL_MD_PATH);
  }

  const rowBase =
    'group flex items-center gap-1.5 rounded px-2 py-1 text-xs cursor-pointer hover:bg-surface-container-high';

  return (
    <div className="rounded border border-outline-variant/30 bg-surface-container-low">
      <div className="flex items-center justify-between border-b border-outline-variant/20 px-2 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-outline">Files</span>
        {!readOnly && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => addFile()}
              title="New file"
              className="text-outline hover:text-on-surface"
            >
              <FilePlus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={addFolder}
              title="New folder"
              className="text-outline hover:text-on-surface"
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      <div className="max-h-[420px] space-y-0.5 overflow-auto p-1">
        {/* SKILL.md — pinned root, never renamable/deletable. */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => onSelectPath(SKILL_MD_PATH)}
          onKeyDown={(e) => e.key === 'Enter' && onSelectPath(SKILL_MD_PATH)}
          className={`${rowBase} ${
            selectedPath === SKILL_MD_PATH ? 'bg-surface-container-high font-medium text-on-surface' : 'text-on-surface-variant'
          }`}
        >
          <FileText className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="truncate">SKILL.md</span>
        </div>

        {groups.map((group) => (
          <div key={group.folder || '__root__'}>
            {group.folder !== '' && (
              <div className="group mt-1 flex items-center gap-1.5 px-2 py-1 text-[11px] text-on-surface-variant">
                <Folder className="h-3.5 w-3.5 shrink-0 text-outline" />
                <span className="truncate font-medium">{group.folder}/</span>
                {!readOnly && (
                  <span className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={() => addFile(group.folder)}
                      title="New file in folder"
                      className="text-outline hover:text-on-surface"
                    >
                      <FilePlus className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => renameFolder(group.folder)}
                      title="Rename folder"
                      className="text-outline hover:text-on-surface"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteFolder(group.folder)}
                      title="Delete folder"
                      className="text-outline hover:text-danger"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </span>
                )}
              </div>
            )}

            {group.files.map((file) => {
              const label = group.folder === '' ? file.path : file.path.slice(group.folder.length + 1);
              return (
                <div
                  key={file.path}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectPath(file.path)}
                  onKeyDown={(e) => e.key === 'Enter' && onSelectPath(file.path)}
                  className={`${rowBase} ${group.folder ? 'pl-5' : ''} ${
                    selectedPath === file.path
                      ? 'bg-surface-container-high font-medium text-on-surface'
                      : 'text-on-surface-variant'
                  }`}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-outline" />
                  <span className="truncate">{label}</span>
                  {!readOnly && (
                    <span className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          renameFile(file);
                        }}
                        title="Rename"
                        className="text-outline hover:text-on-surface"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteFile(file);
                        }}
                        title="Delete"
                        className="text-outline hover:text-danger"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
