import { describe, expect, it } from "vitest";
import { isReservedTopLevel, normalizeRequestPath } from "./app-router";

describe("normalizeRequestPath", () => {
  it("strips leading slashes and keeps nested paths", () => {
    expect(normalizeRequestPath("/assets/app.js")).toBe("assets/app.js");
    expect(normalizeRequestPath("///a/b/c")).toBe("a/b/c");
  });

  it("returns empty string for root-ish input", () => {
    expect(normalizeRequestPath("")).toBe("");
    expect(normalizeRequestPath("/")).toBe("");
    expect(normalizeRequestPath("///")).toBe("");
  });

  it("collapses . and removes .. segments safely", () => {
    expect(normalizeRequestPath("a/./b")).toBe("a/b");
    expect(normalizeRequestPath("a/b/../c")).toBe("a/c");
    expect(normalizeRequestPath("../../etc/passwd")).toBe("etc/passwd");
    expect(normalizeRequestPath("a/../../b")).toBe("b");
  });

  it("decodes percent-encoding", () => {
    expect(normalizeRequestPath("/hello%20world.txt")).toBe("hello world.txt");
    expect(normalizeRequestPath("/dir%2Ffile")).toBe("dir/file");
  });

  it("keeps invalid percent sequences raw instead of throwing", () => {
    expect(normalizeRequestPath("/100%.txt")).toBe("100%.txt");
    expect(normalizeRequestPath("/bad%zz")).toBe("bad%zz");
  });

  it("normalizes backslashes to forward slashes", () => {
    expect(normalizeRequestPath("a\\b\\c")).toBe("a/b/c");
  });
});

describe("isReservedTopLevel", () => {
  it("reserves platform paths", () => {
    for (const seg of ["api", "mcp", "authorize", "oauth", "callback", "assets", "favicon.ico", "robots.txt"]) {
      expect(isReservedTopLevel(seg)).toBe(true);
    }
  });

  it("reserves dotfiles", () => {
    expect(isReservedTopLevel(".well-known")).toBe(true);
  });

  it("allows normal usernames", () => {
    for (const seg of ["alice", "bob42", "my-app"]) {
      expect(isReservedTopLevel(seg)).toBe(false);
    }
  });
});
