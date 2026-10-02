import { randomUUID } from 'node:crypto';
import path from 'node:path';
import multer, { FileFilterCallback } from 'multer';
import type { Request } from 'express';
import { Errors } from '../utils/AppError.js';

const IMAGE_MIME_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

// Campaign creatives only (see below) - a Video Promotion campaign's
// creative upload accepts an actual video file, not just images.
const VIDEO_MIME_TYPES: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
};

const DEFAULT_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

// Campaign creatives alone get a higher ceiling - a video file is
// legitimately larger than a banner image, and this is the one upload
// subdir that ever accepts one. See campaigns.routes.ts.
const CAMPAIGN_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

// Never trusts the client-supplied original filename or extension - the
// stored name is always a fresh UUID plus an extension derived from the
// sniffed mimetype, so there is no path-traversal or double-extension
// (e.g. "proof.jpg.exe") surface at all. Every kind of upload lands in this
// same flat `uploads/` folder (no per-kind subdirectory) - the UUID
// filename is already the only thing that has to stay unique, so there is
// nothing a subdirectory was actually preventing.
export const uploadsDir = path.join(process.cwd(), 'uploads');

function makeStorage(allowedMimeTypes: Record<string, string>) {
  return multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const ext = allowedMimeTypes[file.mimetype] ?? '.bin';
      cb(null, `${randomUUID()}${ext}`);
    },
  });
}

function fileFilterFor(allowedMimeTypes: Record<string, string>, rejectionMessage: string) {
  return (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
    if (!allowedMimeTypes[file.mimetype]) {
      cb(Errors.validation(rejectionMessage));
      return;
    }
    cb(null, true);
  };
}

// `kind` no longer names a storage subdirectory (every upload lands in the
// same flat uploads/ folder - see makeStorage) - it only still selects
// which mime-type/size rule applies, exactly as it did before.
export function imageUpload(kind: 'payment-proofs' | 'platform' | 'campaigns' | 'task-proofs') {
  // Every other kind (payment proofs, platform assets, task proofs) stays
  // image-only at the original 5MB ceiling, unchanged - only campaign
  // creatives (Banner/Image and Video Promotion's shared upload field) also
  // accept a video file, and only that kind gets the larger ceiling.
  const isCampaignCreative = kind === 'campaigns';
  const allowedMimeTypes = isCampaignCreative ? { ...IMAGE_MIME_TYPES, ...VIDEO_MIME_TYPES } : IMAGE_MIME_TYPES;
  const maxFileSizeBytes = isCampaignCreative ? CAMPAIGN_MAX_FILE_SIZE_BYTES : DEFAULT_MAX_FILE_SIZE_BYTES;
  const rejectionMessage = isCampaignCreative
    ? 'Only JPEG, PNG, WEBP images or MP4, WEBM, MOV videos are allowed.'
    : 'Only JPEG, PNG, or WEBP images are allowed.';

  return multer({
    storage: makeStorage(allowedMimeTypes),
    limits: { fileSize: maxFileSizeBytes, files: 1 },
    fileFilter: fileFilterFor(allowedMimeTypes, rejectionMessage),
  });
}

export function publicUploadUrl(filename: string): string {
  return `/uploads/${filename}`;
}

// Inverse of publicUploadUrl, for callers (e.g. the cancelled-campaign
// cleanup job) that only have a stored `/uploads/<filename>` URL and need the
// real file to delete it. Returns null for anything that isn't one of this
// app's own upload URLs - a defensive check, not a real-world case today,
// since every imageUrl/proofImageUrl in the DB is always produced by
// publicUploadUrl above.
export function uploadedFilePath(url: string): string | null {
  if (!url.startsWith('/uploads/')) return null;
  const filename = path.basename(url);
  if (!filename || filename === '..' || filename.includes('/') || filename.includes('\\')) return null;
  return path.join(uploadsDir, filename);
}
