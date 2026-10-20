import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = "https://sezlpakkahwtbxlgjzsb.supabase.co";
const supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNlemxwYWtrYWh3dGJ4bGdqenNiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE4NzQxMDksImV4cCI6MjEwNzQ1MDEwOX0.B6lCCqszvvK6zap9lxKBw0TnrgMnSWbKiFcDwx7itqw";

export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!client) {
    if (!supabaseConfigured) {
      throw new Error("Supabase is not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY");
    }
    client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }
  return client;
}

export async function getAccessToken(): Promise<string | null> {
  if (!supabaseConfigured) return null;
  const { data } = await supabase().auth.getSession();
  return data.session?.access_token ?? null;
}
