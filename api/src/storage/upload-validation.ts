const ALLOWED_EXTENSIONS = new Set([
  'wav',
  'mp3',
  'm4a',
  'flac',
  'ogg',
  'webm',
]);

/**
 * MIME types are client-supplied, so this is a sanity check only —
 * real validation happens in the worker via ffprobe. Unknown/generic
 * types (curl defaults to application/octet-stream) are allowed through.
 */
const ALLOWED_NON_AUDIO_MIMES = new Set([
  'application/octet-stream',
  'application/ogg',
  'video/webm',
]);

export interface UploadRejection {
  reason: string;
}

export function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx > 0 ? filename.slice(idx + 1).toLowerCase() : '';
}

export function validateUpload(
  originalName: string,
  mimeType: string,
): UploadRejection | null {
  const ext = extensionOf(originalName);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return {
      reason: `Unsupported file extension ".${ext}"; allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
    };
  }
  if (
    !mimeType.startsWith('audio/') &&
    !ALLOWED_NON_AUDIO_MIMES.has(mimeType)
  ) {
    return { reason: `Unsupported content type "${mimeType}"` };
  }
  return null;
}
