import { badRequest } from "./errors.js";

// Portable storage contract for uploaded files (member photos today). The fs
// implementation runs on the Node container and R2 on Cloudflare; both share
// this interface so the HTTP layer never touches a filesystem directly.

export interface StoredFile {
  bytes: Uint8Array;
  contentType: string;
}

export interface StorageAdapter {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredFile | null>;
  delete(key: string): Promise<void>;
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

// Content type for an existing object whose metadata wasn't recorded (early fs
// uploads). Falls back to the extension when R2/fs metadata is missing.
export function contentTypeForKey(key: string): string {
  const dot = key.lastIndexOf(".");
  const ext = dot === -1 ? "" : key.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Photo data URLs (the admin photo upload wire format)
// ---------------------------------------------------------------------------

const PHOTO_EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export interface ParsedPhoto {
  mime: string;
  ext: string; // missing mime types fall back to jpg (matches original behavior)
  bytes: Uint8Array;
}

const SEMI = ";";
const BASE64_NO_PAD = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Parse + validate a "data:image/..." URL. Throws HttpError 400 on malformed
// input or over-size payloads, mirroring the old inline upload handler (but
// rejects junk base64 the lenient old Buffer.from silently accepted).
export function parsePhotoDataUrl(dataUrl: unknown): ParsedPhoto {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
    throw badRequest("photo must be a base64 data URL");
  }
  const semi = dataUrl.indexOf(SEMI);
  const comma = dataUrl.indexOf(",");
  if (semi === -1 || semi > comma) throw badRequest("photo must be a base64 data URL");
  const mime = dataUrl.slice(5, semi);
  const ext = PHOTO_EXT_BY_MIME[mime] || "jpg";
  const payload = dataUrl.slice(comma + 1);
  if (!BASE64_NO_PAD.test(payload)) throw badRequest("photo must be a base64 data URL");
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(payload);
  } catch {
    throw badRequest("photo must be a base64 data URL");
  }
  if (bytes.length > MAX_PHOTO_BYTES) {
    throw badRequest("photo too large (max 5MB)");
  }
  return { mime, ext, bytes };
}

// Storage key from the origin `name` hint + extension, e.g. "1726-john.jpg".
export function photoKey(name: unknown, ext: string): string {
  const slug =
    String(name || "photo").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") ||
    "photo";
  return `${Date.now()}-${slug}.${ext}`;
}