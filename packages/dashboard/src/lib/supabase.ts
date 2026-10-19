import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "";
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? "";

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
