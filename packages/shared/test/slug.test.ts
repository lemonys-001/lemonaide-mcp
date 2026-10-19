import { describe, expect, it } from "vitest";
import { isValidSlug, isValidUsername, slugify, validateUsername } from "../src/slug";

describe("slugify", () => {
  it("slugifies simple names", () => {
    expect(slugify("Todo App")).toBe("todo-app");
    expect(slugify("My Portfolio!")).toBe("my-portfolio");
  });

  it("strips accents and non-latin leftovers", () => {
    expect(slugify("Café Résumé")).toBe("cafe-resume");
    expect(slugify("!!!")).toBe("app-app");
  });

  it("never returns an empty slug", () => {
    expect(slugify("").length).toBeGreaterThan(0);
    expect(slugify("   ").length).toBeGreaterThan(0);
  });

  it("caps length at 50", () => {
    expect(slugify("a".repeat(200)).length).toBeLessThanOrEqual(50);
  });

  it("does not end with a hyphen", () => {
    expect(slugify("hello world 123").endsWith("-")).toBe(false);
  });
});

describe("isValidSlug", () => {
  it("accepts valid slugs", () => {
    expect(isValidSlug("todo-app")).toBe(true);
    expect(isValidSlug("a")).toBe(true);
    expect(isValidSlug("a1-b2")).toBe(true);
  });

  it("rejects invalid slugs", () => {
    expect(isValidSlug("-leading")).toBe(false);
    expect(isValidSlug("trailing-")).toBe(false);
    expect(isValidSlug("Upper")).toBe(false);
    expect(isValidSlug("has space")).toBe(false);
    expect(isValidSlug("has_underscore")).toBe(false);
    expect(isValidSlug("a".repeat(51))).toBe(false);
  });
});

describe("validateUsername", () => {
  it("accepts normal usernames", () => {
    expect(validateUsername("lemon")).toBeNull();
    expect(validateUsername("lemon-dev")).toBeNull();
    expect(validateUsername("l3mon")).toBeNull();
  });

  it("flags reserved usernames", () => {
    expect(validateUsername("admin")).toBe("reserved");
    expect(validateUsername("api")).toBe("reserved");
    expect(validateUsername("mcp")).toBe("reserved");
  });

  it("flags length issues", () => {
    expect(validateUsername("ab")).toBe("too_short");
    expect(validateUsername("a".repeat(41))).toBe("too_long");
  });

  it("flags bad characters", () => {
    expect(validateUsername("le_mon")).toBe("bad_chars");
    expect(validateUsername("-lemon")).toBe("bad_chars");
    expect(validateUsername("lemon-")).toBe("bad_chars");
  });

  it("isValidUsername mirrors validateUsername", () => {
    expect(isValidUsername("lemon")).toBe(true);
    expect(isValidUsername("admin")).toBe(false);
  });
});
