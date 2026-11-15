import { describe, expect, it } from "vitest";
import { createApiRouter } from "./router";

// Regression: hono 4.13 broke `c.req.param("*")` for path wildcards, so file
// routes silently received an empty path. Routes now use `:path{.+}` — these
// checks prove the routes match at all (auth middleware rejects first).
describe("file routes match", () => {
  const router = createApiRouter({} as never);

  it.each([
    ["GET", "/api/projects/p1/files/index.html"],
    ["PUT", "/api/projects/p1/files/src/a/b.js"],
    ["DELETE", "/api/projects/p1/files/app.js"],
  ])("%s %s matches a route (no-env auth middleware errors, never 404)", async (method, path) => {
    const res = await router.request(path, { method });
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    // Route matched → auth middleware runs (500 with the empty env stub).
    // Route missed → the "no route" 404. The old wildcard-param bug produced 404s.
    expect(body.error?.message).not.toMatch(/no route/);
    expect(res.status).not.toBe(404);
  });

  it("file list route still matches", async () => {
    const res = await router.request("/api/projects/p1/files");
    expect(res.status).not.toBe(404);
  });
});
