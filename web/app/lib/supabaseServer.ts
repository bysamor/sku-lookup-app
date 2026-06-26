import { createClient } from "@supabase/supabase-js";

// 僅在伺服器端使用（API route / server component）。
// SUPABASE_SERVICE_ROLE_KEY 絕對不可加 NEXT_PUBLIC_ 前綴，否則會被打包進前端。
export function supabaseServer() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key, {
    global: {
      // Next.js 的 fetch patch 對個別 fetch 呼叫的 cache 設定優先於 route 的
      // `dynamic = "force-dynamic"`。Supabase client 內部用全域 fetch，沒有明確
      // 關掉快取時會被 Next.js 的 Data Cache 快取住，導致拿到舊資料。在這裡強制
      // 每個請求都帶 cache: "no-store"，確保永遠讀到最新資料。
      fetch: (url, options) => fetch(url, { ...options, cache: "no-store" }),
    },
  });
}
