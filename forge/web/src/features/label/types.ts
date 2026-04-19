import type { BaseEntity } from '@/lib/types';

export interface Label extends BaseEntity {
  name: string;
  color: string;
  description: string | null;
  project: { id: number; documentId: string } | null;
}

export interface LabelFormData {
  name: string;
  color: string;
  description?: string;
  project: string; // documentId
}
