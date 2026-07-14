import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/app/lib/supabaseServer";
import { lookupSku } from "@/app/lib/skuSearch";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 處理 job 裡下一個 pending item，每次 call 處理一個 SKU
export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await context.params;
  const supabase = supabaseServer();

  // 取下一個 pending item
  const { data: items } = await supabase
    .from("lookup_items")
    .select("*")
    .eq("job_id", jobId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1);

  if (!items || items.length === 0) {
    // 沒有 pending item → 把 job 標為 done
    await supabase
      .from("lookup_jobs")
      .update({ status: "done" })
      .eq("id", jobId)
      .eq("status", "running");
    return NextResponse.json({ done: true });
  }

  const item = items[0];

  // 標記 job 為 running
  await supabase
    .from("lookup_jobs")
    .update({ status: "running" })
    .eq("id", jobId)
    .eq("status", "pending");

  try {
    const result = await lookupSku(item.sku_code);

    // 更新 item
    await supabase
      .from("lookup_items")
      .update({
        product_name: result.product_name || null,
        product_image: result.product_image || null,
        benefits: result.benefits || null,
        ingredients: result.ingredients || null,
        direction: result.direction || null,
        country: result.country || null,
        product_url: result.product_url || null,
        source_site: result.source_site || null,
        status: result.status,
      })
      .eq("id", item.id);

    // 寫入候選來源
    if (result.candidates.length > 0) {
      const rows = result.candidates.map((c) => ({
        item_id: item.id,
        title: c.title,
        url: c.url,
        snippet: c.snippet || null,
        score: c.score,
        matched_sku: c.matched_sku,
        source_site: c.source_site || null,
      }));
      const { data: inserted } = await supabase
        .from("lookup_candidates")
        .insert(rows)
        .select("id, score");

      // 自動選最高分候選
      if (inserted && inserted.length > 0) {
        const best = inserted.reduce((a: { id: string; score: number }, b: { id: string; score: number }) =>
          (b.score || 0) > (a.score || 0) ? b : a
        );
        await supabase
          .from("lookup_candidates")
          .update({ is_selected: true })
          .eq("id", best.id);
        await supabase
          .from("lookup_items")
          .update({ best_candidate_id: best.id })
          .eq("id", item.id);
      }
    }
  } catch {
    await supabase
      .from("lookup_items")
      .update({ status: "failed" })
      .eq("id", item.id);
  }

  // 更新 job 進度
  const { data: job } = await supabase
    .from("lookup_jobs")
    .select("processed_skus, total_skus")
    .eq("id", jobId)
    .single();

  const newProcessed = (job?.processed_skus || 0) + 1;
  const isDone = newProcessed >= (job?.total_skus || 0);

  await supabase
    .from("lookup_jobs")
    .update({
      processed_skus: newProcessed,
      status: isDone ? "done" : "running",
    })
    .eq("id", jobId);

  return NextResponse.json({ done: isDone, processed: newProcessed });
}
