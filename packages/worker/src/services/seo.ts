/**
 * SEO surfaces: robots.txt (static policy) and sitemap.xml (live published
 * apps, pulled from the current deployments). Bing/Google discover hosted
 * sites through the sitemap; crawlers are kept off API/OAuth machinery.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env";

function primaryBase(env: Env): string {
  return env.APP_BASE_DOMAIN.startsWith("http") ? env.APP_BASE_DOMAIN : `https://${env.APP_BASE_DOMAIN}`;
}

export function robotsTxt(env: Env): string {
  const base = primaryBase(env);
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /mcp",
    "Disallow: /oauth",
    "Disallow: /authorize",
    "Disallow: /callback",
    "",
    `Sitemap: ${base}/sitemap.xml`,
    "",
  ].join("\n");
}

export async function sitemapXml(env: Env, db: SupabaseClient): Promise<string> {
  const base = primaryBase(env);
  const { data } = await db
    .from("deployments")
    .select("username, slug, deployed_at, projects!inner(status)")
    .eq("is_current", true)
    .eq("status", "deployed")
    .eq("projects.status", "active")
    .order("deployed_at", { ascending: false })
    .limit(5000);

  const seen = new Set<string>();
  const urls: string[] = [];
  for (const row of data ?? []) {
    const { username, slug, deployed_at: lastmod } = row as { username: string; slug: string; deployed_at: string | null };
    const key = `${username}/${slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(
      `  <url><loc>${base}/${encodeURIComponent(username)}/${encodeURIComponent(slug)}</loc>${
        lastmod ? `<lastmod>${new Date(lastmod).toISOString()}</lastmod>` : ""
      }</url>`,
    );
  }
  urls.push(`  <url><loc>${base}/</loc></url>`);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}
