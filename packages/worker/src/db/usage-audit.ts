/** Usage accounting + audit helpers that never break the caller's flow. */

import type { SupabaseClient } from "@supabase/supabase-js";

export { recordAudit } from "./profiles";

export async function recordUsageSafe(
  db: SupabaseClient,
  input: {
    userId: string;
    projectId?: string;
    kind: "build" | "deploy" | "storage" | "project";
    quantity?: number;
    unit?: "count" | "bytes";
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const { error } = await db.from("usage_records").insert({
      user_id: input.userId,
      project_id: input.projectId ?? null,
      kind: input.kind,
      quantity: input.quantity ?? 1,
      unit: input.unit ?? "count",
      meta: input.meta ?? {},
    });
    if (error) throw error;
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "usage record failed",
        kind: input.kind,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
