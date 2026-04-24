'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Modal } from '@/components/ui/modal';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useCreateProject } from '../hooks/use-projects';

interface CreateProjectModalProps {
  open: boolean;
  onClose: () => void;
}

export function CreateProjectModal({ open, onClose }: CreateProjectModalProps) {
  const router = useRouter();
  const createProject = useCreateProject();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const trimmedName = name.trim();
    const slug = trimmedName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    // Core's create-project schema accepts { slug, name } only — description
    // is captured here for UX but not persisted until core grows the field.
    void description;
    createProject.mutate(
      { name: trimmedName, slug },
      {
        onSuccess: (project) => {
          onClose();
          setName('');
          setDescription('');
          router.push(`/projects/${project.slug || slug}`);
        },
      },
    );
  };

  const handleClose = () => {
    if (!createProject.isPending) {
      onClose();
      setName('');
      setDescription('');
    }
  };

  return (
    <Modal open={open} onClose={handleClose}>
      <form onSubmit={handleSubmit} className="p-6">
        <h2 className="mb-4 text-lg font-semibold text-primary">New Project</h2>

        {createProject.isError && (
          <div className="mb-4">
            <AlertBanner variant="error">Failed to create project. Please try again.</AlertBanner>
          </div>
        )}

        <div className="mb-4">
          <Label htmlFor="project-name">
            Name <span className="text-error">*</span>
          </Label>
          <Input
            id="project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Project"
            required
            autoFocus
          />
        </div>

        <div className="mb-6">
          <Label htmlFor="project-description">Description</Label>
          <Textarea
            id="project-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional description..."
            rows={3}
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={handleClose}
            disabled={createProject.isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!name.trim() || createProject.isPending}
          >
            {createProject.isPending ? 'Creating...' : 'Create Project'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
