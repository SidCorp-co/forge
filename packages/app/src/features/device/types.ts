export interface Device {
  id: number;
  documentId: string;
  name: string;
  deviceId: string;
  lastSeen: string | null;
  projectsRoot?: string | null;
  projectPaths?: Record<string, string> | null;
}
