import { createClient } from "@supabase/supabase-js";

// 僅在伺服器端使用（API route / server component）。
// SUPABASE_SERVICE_ROLE_KEY 絕對不可加 NEXT_PUBLIC_ 前綴，否則會被打包進前端。
export function supabaseServer() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key);
}
