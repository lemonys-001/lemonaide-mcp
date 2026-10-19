import { describe, expect, it } from "vitest";
import { buildPrefix, contentTypeFor, currentTreeRoot, sha256Hex, snapshotRoot } from "./source";

describe("contentTypeFor", () => {
  it("maps common web types", () => {
    expect(contentTypeFor("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("app/main.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("styles/main.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("data.json")).toBe("application/json; charset=utf-8");
    expect(contentTypeFor("img/logo.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("img/photo.png")).toBe("image/png");
  });

  it("falls back to octet-stream", () => {
    expect(contentTypeFor("blob.bin")).toContain("application/octet-stream");
    expect(contentTypeFor("weird.xyz.unknown")).toContain("application/octet-stream");
  });
});

describe("storage prefixes", () => {
  it("builds deployment artifact prefixes", () => {
    expect(buildPrefix("b-1")).toBe("build/b-1/dist");
  });

  it("builds source roots and version snapshots", () => {
    expect(currentTreeRoot("p-1")).toBe("src/p-1/files");
    expect(snapshotRoot("p-1", 3)).toBe("src/p-1/v/3");
  });
});

describe("sha256Hex", () => {
  it("hashes bytes to stable hex", async () => {
    const hex = await sha256Hex(new TextEncoder().encode("hello"));
    expect(hex).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("hashes ArrayBuffer identically", async () => {
    const bytes = new TextEncoder().encode("hello");
    const hex = await sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(hex).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});
