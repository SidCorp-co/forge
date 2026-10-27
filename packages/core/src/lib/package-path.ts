import { createRequire } from 'node:module';

export function resolvePackageFile(fromUrl: string, spec: string): string {
  return createRequire(fromUrl).resolve(spec);
}
