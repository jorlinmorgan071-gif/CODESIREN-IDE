// Session-only local VRM selection. This module never uploads or persists a
// selected file; callers own the resulting blob URL and must revoke it.

export const MAX_LOCAL_VRM_BYTES = 100 * 1024 * 1024;

export interface LocalVrmSession {
  url: string;
  fileName: string;
  sizeBytes: number;
}

export function validateLocalVrmFile(file: Pick<File, 'name' | 'size'>): string | null {
  if (!/\.vrm$/i.test(file.name)) {
    return 'Choose a VRM (.vrm) file.';
  }
  if (file.size <= 0) {
    return 'The selected VRM file is empty.';
  }
  if (file.size > MAX_LOCAL_VRM_BYTES) {
    return 'The selected VRM is larger than the 100 MiB session limit.';
  }
  return null;
}

export function createLocalVrmSession(file: File): LocalVrmSession {
  const validationError = validateLocalVrmFile(file);
  if (validationError) {
    throw new Error(validationError);
  }
  return {
    url: URL.createObjectURL(file),
    fileName: file.name,
    sizeBytes: file.size,
  };
}

export function revokeLocalVrmSession(session: LocalVrmSession | null): void {
  if (session?.url.startsWith('blob:')) {
    URL.revokeObjectURL(session.url);
  }
}
