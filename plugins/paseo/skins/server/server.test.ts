import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { isPermissiveLicense } from "../shared/license";
import { CATALOG_TTL_MS, CatalogStore, filterCatalog, paginate, parseCatalog } from "./catalog";
import { coverRect } from "./decode";
import { fetchBytes } from "./http";
import { readImageInfo } from "./image-info";
import { luminancePercentiles, relativeLuminance } from "./luminance";
import { resolveDataDir } from "./paths";
import { makeThumbnail } from "./thumbnail";
import { sha256Hex, verifyImage } from "./verify";

function makePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = pixel(x, y);
      const at = (y * width + x) * 4;
      png.data[at] = red;
      png.data[at + 1] = green;
      png.data[at + 2] = blue;
      png.data[at + 3] = 255;
    }
  }
  return new Uint8Array(PNG.sync.write(png));
}

function makeJpeg(width: number, height: number) {
  const data = Buffer.alloc(width * height * 4, 128);
  return new Uint8Array(jpeg.encode({ width, height, data }, 80).data);
}

describe("isPermissiveLicense", () => {
  it.each(["MIT", "mit", "MiT", "CC0", "CC0 1.0", "CC BY 4.0", "cc-by-4.0", "CC BY-SA 4.0", "Pixabay Content License", "Unsplash License", "Public Domain", " public  domain "])(
    "accepts %s",
    (license) => expect(isPermissiveLicense(license)).toBe(true),
  );
  it.each([
    "All Rights Reserved",
    "Personal Use Only",
    "Private Use",
    "Proprietary",
    "CC BY-NC 4.0",
    "CC BY-NC-SA 4.0",
    "CC BY-ND 4.0",
    "CC",
    "MIT0d000721",
    "zeBy",
    "GuiMing Personal Use License 1.0",
    "",
  ])("rejects %s", (license) => expect(isPermissiveLicense(license)).toBe(false));
});

describe("readImageInfo", () => {
  it("reads PNG dimensions", () => {
    expect(readImageInfo(makePng(7, 5, () => [0, 0, 0]))).toEqual({ mimeType: "image/png", width: 7, height: 5 });
  });
  it("reads JPEG dimensions", () => {
    expect(readImageInfo(makeJpeg(33, 17))).toEqual({ mimeType: "image/jpeg", width: 33, height: 17 });
  });
  it("reads WebP VP8, VP8L and VP8X headers", () => {
    const header = (chunk: string, body: number[]) => {
      const bytes = new Uint8Array(40);
      bytes.set([...Buffer.from("RIFF")], 0);
      bytes.set([...Buffer.from("WEBP")], 8);
      bytes.set([...Buffer.from(chunk)], 12);
      bytes.set(body, 20);
      return bytes;
    };
    // VP8: frame tag at 20..22, start code 9d 01 2a, then 14-bit LE width/height.
    expect(readImageInfo(header("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0x00]))).toEqual({
      mimeType: "image/webp",
      width: 320,
      height: 240,
    });
    // VP8L: signature 2f, then 14 bits (width-1) and 14 bits (height-1).
    const bits = (99 | (49 << 14)) >>> 0;
    expect(
      readImageInfo(header("VP8L", [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff])),
    ).toEqual({ mimeType: "image/webp", width: 100, height: 50 });
    // VP8X: 24-bit LE canvas size minus one at offsets 24 and 27.
    expect(readImageInfo(header("VP8X", [0, 0, 0, 0, 0xff, 0x03, 0x00, 0xff, 0x01, 0x00]))).toEqual({
      mimeType: "image/webp",
      width: 1024,
      height: 512,
    });
  });
  it("rejects unknown and truncated data", () => {
    expect(readImageInfo(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(readImageInfo(makePng(7, 5, () => [0, 0, 0]).slice(0, 20))).toBeNull();
  });
});

describe("verifyImage", () => {
  const image = makePng(8, 4, () => [10, 20, 30]);
  const integrity = { algorithm: "sha256" as const, sha256: sha256Hex(image), bytes: image.byteLength, width: 8, height: 4 };

  it("accepts a matching image", () => {
    expect(verifyImage(image, integrity)).toEqual({ mimeType: "image/png", width: 8, height: 4 });
  });
  it("rejects a wrong checksum, size, or dimensions", () => {
    expect(() => verifyImage(image, { ...integrity, sha256: "0".repeat(64) })).toThrow(/checksum/);
    expect(() => verifyImage(image, { ...integrity, bytes: integrity.bytes + 1 })).toThrow(/bytes/);
    expect(() => verifyImage(image, { ...integrity, width: 9 })).toThrow(/manifest says 9×4/);
  });
  it("rejects bytes that are not an image", () => {
    const bytes = new TextEncoder().encode("not an image at all");
    expect(() => verifyImage(bytes, { ...integrity, sha256: sha256Hex(bytes), bytes: bytes.byteLength })).toThrow(
      /not a valid/,
    );
  });
});

describe("luminance", () => {
  it("matches WCAG reference values", () => {
    expect(relativeLuminance(0, 0, 0)).toBe(0);
    expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 10);
    expect(relativeLuminance(255, 0, 0)).toBeCloseTo(0.2126, 4);
  });
  it("takes the 1st and 99th percentile, ignoring outliers", () => {
    const width = 100;
    const height = 100;
    const data = new Uint8Array(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
      const value = index === 0 ? 0 : index === 1 ? 255 : 100;
      data.set([value, value, value, 255], index * 4);
    }
    const result = luminancePercentiles({ width, height, data });
    expect(result?.low).toBeCloseTo(relativeLuminance(100, 100, 100), 6);
    expect(result?.high).toBeCloseTo(relativeLuminance(100, 100, 100), 6);
  });
  it("reports the spread of a gradient", () => {
    const width = 256;
    const data = new Uint8Array(width * 4);
    for (let x = 0; x < width; x += 1) data.set([x, x, x, 255], x * 4);
    const result = luminancePercentiles({ width, height: 1, data });
    expect(result?.low).toBeLessThan(0.002);
    expect(result?.high).toBeGreaterThan(0.95);
  });
  it("returns null for a fully transparent image", () => {
    expect(luminancePercentiles({ width: 1, height: 1, data: new Uint8Array(4) })).toBeNull();
  });
});

describe("thumbnails", () => {
  it("crops around the focal point and stays within 512×288", () => {
    // Left half red, right half blue; a focal point at the right edge must yield blue.
    const source = makePng(3200, 900, (x) => (x < 1600 ? [255, 0, 0] : [0, 0, 255]));
    const thumb = makeThumbnail(source, { x: 1, y: 0.5 });
    expect(thumb.mimeType).toBe("image/jpeg");
    const decoded = jpeg.decode(Buffer.from(thumb.base64, "base64"), { useTArray: true });
    expect(decoded.width).toBeLessThanOrEqual(512);
    expect(decoded.height).toBeLessThanOrEqual(288);
    expect(decoded.data[2]!).toBeGreaterThan(200);
    expect(decoded.data[0]!).toBeLessThan(60);
  });
  it("cover-crops a portrait image to 16:9", () => {
    expect(coverRect(900, 1600, 16 / 9, { x: 0.5, y: 0 })).toEqual({ x: 0, y: 0, width: 900, height: 506 });
  });
  it("passes small WebP through and refuses large WebP", () => {
    const webp = new Uint8Array(40);
    webp.set([...Buffer.from("RIFF")], 0);
    webp.set([...Buffer.from("WEBP")], 8);
    webp.set([...Buffer.from("VP8X")], 12);
    expect(makeThumbnail(webp, { x: 0.5, y: 0.5 }).mimeType).toBe("image/webp");
    const large = new Uint8Array(1.5 * 1024 * 1024 + 1);
    large.set(webp);
    expect(() => makeThumbnail(large, { x: 0.5, y: 0.5 })).toThrow("Preview unavailable");
  });
});

describe("resolveDataDir", () => {
  it("uses PASEO_HOME when set", () => {
    expect(resolveDataDir({ PASEO_HOME: "/data/paseo" }, "/home/me")).toBe("/data/paseo/plugin-data/paseo-skins");
    expect(resolveDataDir({ PASEO_HOME: "~/custom" }, "/home/me")).toBe("/home/me/custom/plugin-data/paseo-skins");
  });
  it("falls back to ~/.paseo", () => {
    expect(resolveDataDir({}, "/home/me")).toBe("/home/me/.paseo/plugin-data/paseo-skins");
  });
});

const CATALOG = JSON.stringify({
  schemaVersion: 1,
  themes: [
    { id: "a-mist", name: "晨雾", englishName: "Morning Mist", author: "Ann", license: "MIT", tags: ["浅色"], manifest: "./themes/a-mist.theme.json", popularRank: 2 },
    { id: "b-night", name: "夜", author: "Bob", license: "CC BY-NC 4.0", tags: ["深色"], manifest: "./themes/b-night.theme.json", popularRank: 1 },
    { id: "c-dark", name: "Dark", author: "Cy", license: "CC BY 4.0", tags: ["深色"], manifest: "./themes/c-dark.theme.json", popularRank: 3 },
    { id: "evil", name: "Evil", license: "MIT", manifest: "https://evil.example/x.theme.json" },
    { id: "http", name: "Http", license: "MIT", manifest: "http://huangguang1999.github.io/paseo-skins/themes/x.json" },
    { name: "no id", manifest: "./x.json" },
  ],
});

describe("catalog", () => {
  const sources = parseCatalog(new TextEncoder().encode(CATALOG));
  it("drops malformed entries and manifests outside the catalog directory", () => {
    expect(sources.map((source) => source.id).sort()).toEqual(["a-mist", "b-night", "c-dark"]);
  });
  it("prefers the English name and reads appearance from tags", () => {
    const mist = sources.find((source) => source.id === "a-mist");
    expect(mist?.name).toBe("Morning Mist");
    expect(mist?.appearance).toBe("light");
  });
  it("excludes non-permissive licenses by default and sorts by popularity", () => {
    const base = { licenseFilter: "permissive" as const, page: 1, pageSize: 24 };
    expect(filterCatalog(sources, base).map((s) => s.id)).toEqual(["a-mist", "c-dark"]);
    expect(filterCatalog(sources, { ...base, licenseFilter: "all" }).map((s) => s.id)).toEqual([
      "b-night",
      "a-mist",
      "c-dark",
    ]);
  });
  it("filters by appearance and query", () => {
    const base = { licenseFilter: "all" as const, page: 1, pageSize: 24 };
    expect(filterCatalog(sources, { ...base, appearance: "dark" }).map((s) => s.id)).toEqual(["b-night", "c-dark"]);
    expect(filterCatalog(sources, { ...base, query: "mist" }).map((s) => s.id)).toEqual(["a-mist"]);
    expect(filterCatalog(sources, { ...base, query: "bob" }).map((s) => s.id)).toEqual(["b-night"]);
  });
  it("paginates and clamps the page", () => {
    const result = paginate([1, 2, 3, 4, 5], 9, 2);
    expect(result).toEqual({ items: [5], page: 3, pageCount: 3 });
  });
});

describe("CatalogStore", () => {
  let directory: string | null = null;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = null;
  });

  it("caches in memory and on disk for six hours, and serves stale when offline", async () => {
    directory = await mkdtemp(join(tmpdir(), "paseo-skins-test-"));
    let now = 1_000;
    let fetches = 0;
    let offline = false;
    const fetchCatalog = async () => {
      fetches += 1;
      if (offline) throw new Error("offline");
      return new TextEncoder().encode(CATALOG);
    };
    const store = new CatalogStore(directory, () => now, fetchCatalog);
    await store.load();
    await store.load();
    expect(fetches).toBe(1);

    // A new process (empty memory) reads the disk copy.
    const second = new CatalogStore(directory, () => now + 1000, fetchCatalog);
    expect((await second.load()).stale).toBe(false);
    expect(fetches).toBe(1);

    now += CATALOG_TTL_MS + 1;
    offline = true;
    const stale = await store.load();
    expect(stale.stale).toBe(true);
    expect(stale.sources).toHaveLength(3);
    expect(fetches).toBe(2);
    await store.load();
    expect(fetches).toBe(2);
  });
});

describe("fetchBytes", () => {
  const ok = (body: string, headers: Record<string, string> = {}) => new Response(body, { headers });
  it("refuses non-HTTPS URLs", async () => {
    await expect(fetchBytes(new URL("http://example.com/a"), 10)).rejects.toThrow(/non-HTTPS/);
  });
  it("enforces the size cap", async () => {
    await expect(fetchBytes(new URL("https://example.com/a"), 4, async () => ok("12345"))).rejects.toThrow(/exceeds/);
    await expect(
      fetchBytes(new URL("https://example.com/a"), 4, async () => ok("1", { "content-length": "99" })),
    ).rejects.toThrow(/exceeds/);
  });
  it("follows same-host redirects but not cross-host or downgrade redirects", async () => {
    const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
    const calls: string[] = [];
    const bytes = await fetchBytes(new URL("https://example.com/a"), 10, async (url) => {
      calls.push(String(url));
      return calls.length === 1 ? redirect("/b") : ok("ok");
    });
    expect(new TextDecoder().decode(bytes)).toBe("ok");
    expect(calls).toEqual(["https://example.com/a", "https://example.com/b"]);
    await expect(
      fetchBytes(new URL("https://example.com/a"), 10, async () => redirect("https://other.example/b")),
    ).rejects.toThrow(/Refusing redirect/);
    await expect(
      fetchBytes(new URL("https://example.com/a"), 10, async () => redirect("http://example.com/b")),
    ).rejects.toThrow(/non-HTTPS/);
  });
});
