import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PHOTO_BYTES,
  contentTypeForKey,
  parsePhotoDataUrl,
  photoKey,
  type StorageAdapter,
} from "../src/core/storage.js";
import { createFsStorage } from "../src/core/storage-fs.js";
import { createR2Storage } from "../src/core/storage-r2.js";
import { closeD1, getTestR2 } from "./helpers/db.js";

// Storage adapters: same interface, two backends. fs runs on the Node
// container, R2 on Cloudflare (Miniflare's real R2 implementation here), plus
// the shared photo data-URL parsing that both upload paths use.

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_B64 = btoa(String.fromCharCode(...PNG));

describe("core/storage helpers", () => {
  it("contentTypeForKey maps extensions", () => {
    expect(contentTypeForKey("x.png")).toBe("image/png");
    expect(contentTypeForKey("x.JPG")).toBe("image/jpeg");
    expect(contentTypeForKey("x.webp")).toBe("image/webp");
    expect(contentTypeForKey("unknown")).toBe("application/octet-stream");
  });

  it("parsePhotoDataUrl accepts image data URLs", () => {
    const photo = parsePhotoDataUrl(`data:image/png;base64,${PNG_B64}`);
    expect(photo.mime).toBe("image/png");
    expect(photo.ext).toBe("png");
    expect(Buffer.from(photo.bytes).equals(Buffer.from(PNG))).toBe(true);
  });

  it("parsePhotoDataUrl falls back to jpg for unknown image mimes", () => {
    const photo = parsePhotoDataUrl(`data:image/avif;base64,${PNG_B64}`);
    expect(photo.ext).toBe("jpg");
    expect(photo.mime).toBe("image/avif");
  });

  it("parsePhotoDataUrl rejects non-image or malformed input", () => {
    expect(() => parsePhotoDataUrl(undefined)).toThrow("photo must be a base64 data URL");
    expect(() => parsePhotoDataUrl("https://example.com/a.jpg")).toThrow("photo must be a base64 data URL");
    expect(() => parsePhotoDataUrl("data:image/png;base64,!!")).toThrow("photo must be a base64 data URL");
    expect(() => parsePhotoDataUrl("data:application/octet-stream;base64,AAAA")).toThrow(
      "photo must be a base64 data URL"
    );
  });

  it("parsePhotoDataUrl caps at 5MB", () => {
    // ~5.25MB decoded (7MB of base64 text), just over the limit
    const big = "a".repeat(7 * 1024 * 1024);
    expect(() => parsePhotoDataUrl(`data:image/png;base64,${big}`)).toThrow("photo too large (max 5MB)");
  });

  it("photoKey builds timestamped server-side keys", () => {
    expect(photoKey("John Smith!", "png")).toMatch(/^\d+-john-smith\.png$/);
    expect(photoKey(undefined, "jpg")).toMatch(/^\d+-photo\.jpg$/);
    expect(photoKey("!!!", "png")).toMatch(/^\d+-photo\.png$/);
  });

  it("photoKey keeps the returned URL stable between calls (pure slug)", () => {
    const a = photoKey("Amy", "jpg").replace(/^\d+-/, "");
    const b = photoKey("Amy", "jpg").replace(/^\d+-/, "");
    expect(a).toBe(b);
  });
});

describe("core/storage fs backend", () => {
  let root: string;
  let parent: string;
  let storage: StorageAdapter;

  beforeAll(() => {
    parent = mkdtempSync(join(tmpdir(), "clan-storage-"));
    root = join(parent, "root");
  });

  afterAll(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  beforeEach(async () => {
    storage = createFsStorage(root);
  });

  it("round-trips a file with content-type from the key", async () => {
    await storage.put("a.png", PNG, "image/png");
    const got = await storage.get("a.png");
    expect(got).not.toBeNull();
    expect(Buffer.from(got!.bytes).equals(Buffer.from(PNG))).toBe(true);
    expect(got!.contentType).toBe("image/png");
    expect(existsSync(join(root, "a.png"))).toBe(true);
  });

  it("returns null for missing keys", async () => {
    expect(await storage.get("missing.png")).toBeNull();
  });

  it("delete removes files and is idempotent", async () => {
    await storage.put("b.png", PNG, "image/png");
    await storage.delete("b.png");
    expect(await storage.get("b.png")).toBeNull();
    await expect(storage.delete("b.png")).resolves.toBeUndefined();
  });

  it("legacy uploads without metadata get ext-based content-type", async () => {
    const saved = join(root, "legacy.jpg");
    // simulate an old upload: write a file the fs adapter will serve
    // but which was never put through the adapter
    const { writeFileSync } = await import("node:fs");
    writeFileSync(saved, PNG);
    const got = await storage.get("legacy.jpg");
    expect(got!.contentType).toBe("image/jpeg");
    rmSync(saved);
  });

  it("treats keys as untrusted: traversal cannot escape the root", async () => {
    await storage.put("../../escape.png", PNG, "image/png");
    expect(existsSync(join(parent, "escape.png"))).toBe(false);
    // a hostile read maps to a different (sanitized) key, so it can't reach
    // the real file
    await storage.put("safe.png", PNG, "image/png");
    expect(await storage.get("../../safe.png")).toBeNull();
    expect((await storage.get("safe.png"))?.bytes).toBeDefined();
  });
});

describe("core/storage r2 backend", () => {
  let storage: StorageAdapter;

  beforeAll(async () => {
    await closeD1(); // ensure a pristine miniflare
  });

  beforeEach(async () => {
    await closeD1();
    storage = createR2Storage(await getTestR2());
  });

  afterAll(async () => {
    await closeD1();
  });

  it("round-trips a file with recorded content-type", async () => {
    await storage.put("a.png", PNG, "image/png");
    const got = await storage.get("a.png");
    expect(got).not.toBeNull();
    expect(Buffer.from(got!.bytes).equals(Buffer.from(PNG))).toBe(true);
    expect(got!.contentType).toBe("image/png");
  });

  it("returns null for missing keys", async () => {
    expect(await storage.get("missing.png")).toBeNull();
  });

  it("delete removes objects and is idempotent", async () => {
    await storage.put("b.png", PNG, "image/png");
    await storage.delete("b.png");
    expect(await storage.get("b.png")).toBeNull();
    await expect(storage.delete("b.png")).resolves.toBeUndefined();
  });

  it("objects without metadata get ext-based content-type", async () => {
    const bucket = await getTestR2();
    await bucket.put("legacy.jpg", PNG.buffer);
    const got = await storage.get("legacy.jpg");
    expect(got!.contentType).toBe("image/jpeg");
  });

  it("r2 object bytes match a large payload", async () => {
    const big = new Uint8Array(2 * 1024 * 1024);
    big.fill(7);
    await storage.put("big.png", big, "image/png");
    const got = await storage.get("big.png");
    expect(got!.bytes.length).toBe(big.length);
    expect(got!.bytes[big.length - 1]).toBe(7);
  });
});

// Sanity: the admin upload path validation used by the live server.
describe("photo wire round-trip", () => {
  async function echo(bytes: Uint8Array): Promise<Uint8Array | null> {
    const file = join(tmpdir(), "clan-storage-echo.bin");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, bytes);
    const back = readFileSync(file);
    rmSync(file, { force: true });
    return new Uint8Array(back);
  }

  it("a parsed PNG survives a bytes round-trip", async () => {
    const photo = parsePhotoDataUrl(`data:image/png;base64,${PNG_B64}`);
    const back = await echo(photo.bytes);
    expect(Buffer.from(back!).equals(Buffer.from(photo.bytes))).toBe(true);
  });
});