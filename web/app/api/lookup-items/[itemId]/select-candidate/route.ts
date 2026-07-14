import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/app/lib/supabaseServer";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ itemId: string }> }
) {
  const { itemId } = await context.params;
  const body = await req.json().catch(() => null);
  const candidateId: string | undefined = body?.candidateId;

  if (!candidateId) {
    return NextResponse.json({ error: "candidateId is required" }, { status: 400 });
  }

  const supabase = supabaseServer();

  // 取出候選資料（含 URL、SKU）
  const { data: candidate, error: candidateError } = await supabase
    .from("lookup_candidates")
    .select("*, lookup_items!lookup_candidates_item_id_fkey(sku_code)")
    .eq("id", candidateId)
    .eq("item_id", itemId)
    .single();

  if (candidateError || !candidate) {
    return NextResponse.json({ error: candidateError?.message || "candidate not found" }, { status: 404 });
  }

  // 先立即更新 DB 標記（前端馬上能看到切換），product_url/source_site 先更新
  await supabase.from("lookup_candidates").update({ is_selected: false }).eq("item_id", itemId);
  await supabase.from("lookup_candidates").update({ is_selected: true }).eq("id", candidateId);

  const { data: item, error: itemError } = await supabase
    .from("lookup_items")
    .update({
      best_candidate_id: candidateId,
      product_url: candidate.url,
      source_site: candidate.source_site,
      status: "needs_review",
      reviewed: true,
    })
    .eq("id", itemId)
    .select("*")
    .single();

  if (itemError) {
    return NextResponse.json({ error: itemError.message }, { status: 500 });
  }

  // 非同步呼叫 worker 重新抓取該候選頁的產品內容欄位（benefits/ingredients 等）
  const workerUrl = process.env.WORKER_BASE_URL;
  const sku = (candidate as { lookup_items?: { sku_code?: string } }).lookup_items?.sku_code || "";
  if (workerUrl && candidate.url && sku) {
    fetch(`${workerUrl}/re-extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        item_id: itemId,
        url: candidate.url,
        sku,
        candidate_id: candidateId,
      }),
    }).catch(() => {});
  }

  return NextResponse.json({ item, reExtracting: !!(workerUrl && candidate.url && sku) });
}
