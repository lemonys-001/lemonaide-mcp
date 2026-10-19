import { describe, expect, it } from "vitest";
import { canTransitionDeployment } from "../src/constants";
import { BuildProjectInput, CreateProjectInput, DeleteProjectInput, WriteProjectFileInput, WriteProjectFilesInput } from "../src/schemas";

describe("CreateProjectInput", () => {
  it("defaults framework", () => {
    const parsed = CreateProjectInput.parse({ name: "Todo App" });
    expect(parsed.framework).toBe("vanilla-html");
  });

  it("rejects empty and oversized names", () => {
    expect(CreateProjectInput.safeParse({ name: "" }).success).toBe(false);
    expect(CreateProjectInput.safeParse({ name: "x".repeat(51) }).success).toBe(false);
  });

  it("rejects unsupported frameworks", () => {
    expect(CreateProjectInput.safeParse({ name: "ok", framework: "nextjs" }).success).toBe(false);
  });

  it("accepts a valid explicit slug", () => {
    const parsed = CreateProjectInput.parse({ name: "My App", slug: "my-app" });
    expect(parsed.slug).toBe("my-app");
  });

  it("rejects invalid slugs", () => {
    expect(CreateProjectInput.safeParse({ name: "My App", slug: "-bad-" }).success).toBe(false);
  });
});

describe("WriteProjectFileInput", () => {
  it("accepts safe paths", () => {
    expect(
      WriteProjectFileInput.safeParse({ project_id: "8b7a5f8e-0f4a-4b0e-9d0f-2b6f3f1a1111", path: "src/app.ts", content: "x" })
        .success,
    ).toBe(true);
  });

  it("rejects traversal paths", () => {
    expect(
      WriteProjectFileInput.safeParse({ project_id: "8b7a5f8e-0f4a-4b0e-9d0f-2b6f3f1a1111", path: "../x", content: "x" })
        .success,
    ).toBe(false);
  });

  it("rejects invalid project ids", () => {
    expect(WriteProjectFileInput.safeParse({ project_id: "nope", path: "a.txt", content: "x" }).success).toBe(false);
  });
});

describe("WriteProjectFilesInput", () => {
  it("caps batch size at 100", () => {
    const files = Array.from({ length: 101 }, (_, i) => ({ path: `f${i}.ts`, content: "" }));
    expect(WriteProjectFilesInput.safeParse({ project_id: "8b7a5f8e-0f4a-4b0e-9d0f-2b6f3f1a1111", files }).success).toBe(false);
  });

  it("rejects batches containing a bad path", () => {
    const files = [
      { path: "ok.ts", content: "" },
      { path: "../../evil", content: "" },
    ];
    expect(WriteProjectFilesInput.safeParse({ project_id: "8b7a5f8e-0f4a-4b0e-9d0f-2b6f3f1a1111", files }).success).toBe(false);
  });
});

describe("DeleteProjectInput", () => {
  it("requires confirm_slug", () => {
    expect(DeleteProjectInput.safeParse({ project_id: "8b7a5f8e-0f4a-4b0e-9d0f-2b6f3f1a1111" }).success).toBe(false);
    expect(
      DeleteProjectInput.safeParse({ project_id: "8b7a5f8e-0f4a-4b0e-9d0f-2b6f3f1a1111", confirm_slug: "my-app" }).success,
    ).toBe(true);
  });
});

describe("BuildProjectInput", () => {
  it("parses with defaults", () => {
    const parsed = BuildProjectInput.parse({ project_id: "8b7a5f8e-0f4a-4b0e-9d0f-2b6f3f1a1111" });
    expect(parsed.install_dependencies).toBe(true);
  });
});

describe("deployment state machine", () => {
  it("allows the happy path", () => {
    expect(canTransitionDeployment("pending", "deploying")).toBe(true);
    expect(canTransitionDeployment("deploying", "deployed")).toBe(true);
  });

  it("allows failure and rollback", () => {
    expect(canTransitionDeployment("pending", "failed")).toBe(true);
    expect(canTransitionDeployment("deploying", "failed")).toBe(true);
    expect(canTransitionDeployment("deployed", "superseded")).toBe(true);
    expect(canTransitionDeployment("deployed", "rolled_back")).toBe(true);
  });

  it("forbids impossible transitions", () => {
    expect(canTransitionDeployment("failed", "deployed")).toBe(false);
    expect(canTransitionDeployment("deployed", "deploying")).toBe(false);
    expect(canTransitionDeployment("pending", "deployed")).toBe(false);
    expect(canTransitionDeployment("rolled_back", "deployed")).toBe(false);
  });
});
