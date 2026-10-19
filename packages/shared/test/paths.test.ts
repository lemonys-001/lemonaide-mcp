import { describe, expect, it } from "vitest";
import { isValidProjectPath, joinKey, keyInRoot, normalizePath, validateProjectPath } from "../src/paths";

describe("validateProjectPath", () => {
  it("accepts normal relative paths", () => {
    expect(validateProjectPath("index.html")).toBeNull();
    expect(validateProjectPath("src/main.tsx")).toBeNull();
    expect(validateProjectPath("src/components/Button.tsx")).toBeNull();
    expect(validateProjectPath("public/assets/logo.svg")).toBeNull();
  });

  it("rejects traversal attempts", () => {
    expect(validateProjectPath("../etc/passwd")).toBe("traversal");
    expect(validateProjectPath("src/../../secret")).toBe("traversal");
    expect(validateProjectPath("a/./b/../..")).toBe("traversal");
    expect(validateProjectPath("..")).toBe("traversal");
    expect(validateProjectPath("foo/..")).toBe("traversal");
  });

  it("rejects absolute paths", () => {
    expect(validateProjectPath("/etc/passwd")).toBe("absolute");
    expect(validateProjectPath("C:/Windows/system32")).toBe("absolute");
  });

  it("rejects backslashes, NUL, empty, overlong", () => {
    expect(validateProjectPath("src\\main.ts")).toBe("backslash");
    expect(validateProjectPath("a\0b")).toBe("nul");
    expect(validateProjectPath("")).toBe("empty");
    expect(validateProjectPath("a".repeat(401))).toBe("too_long");
  });

  it("rejects reserved prefixes", () => {
    expect(validateProjectPath("node_modules/foo/index.js")).toBe("reserved_prefix");
    expect(validateProjectPath(".git/config")).toBe("reserved_prefix");
    expect(validateProjectPath(".wrangler/state")).toBe("reserved_prefix");
  });

  it("rejects double slashes and trailing slash ambiguity", () => {
    expect(validateProjectPath("src//main.ts")).toBe("traversal");
    expect(validateProjectPath("src/")).toBe("traversal");
  });
});

describe("normalizePath", () => {
  it("collapses redundant segments after validation", () => {
    expect(normalizePath("a//b")).toBe("a/b");
    expect(normalizePath("./a/b")).toBe("a/b");
  });
});

describe("joinKey", () => {
  it("joins root and validated path", () => {
    expect(joinKey("projects/p1/current", "src/app.ts")).toBe("projects/p1/current/src/app.ts");
  });

  it("throws on unsafe paths", () => {
    expect(() => joinKey("projects/p1/current", "../other")).toThrow(/invalid project path/);
  });
});

describe("keyInRoot", () => {
  it("detects containment", () => {
    expect(keyInRoot("projects/p1/current/a.html", "projects/p1/current")).toBe(true);
    expect(keyInRoot("projects/p10/current/a.html", "projects/p1")).toBe(false);
    expect(keyInRoot("projects/p1", "projects/p1")).toBe(true);
  });
});

describe("isValidProjectPath", () => {
  it("mirrors validateProjectPath", () => {
    expect(isValidProjectPath("src/main.ts")).toBe(true);
    expect(isValidProjectPath("../../x")).toBe(false);
  });
});
