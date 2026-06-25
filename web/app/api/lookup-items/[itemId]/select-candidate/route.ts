import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/app/lib/supabaseServer";

// 使用者在候選列表中手動選擇「最佳結果」
// MVP：只切換 best_candidate_id / 產品網址 / 來源網站，其餘欄位仍可由使用者手動編輯填入。
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

  const { data: candidate, error: candidateError } = await supabase
    .from("lookup_candidates")
    .select("*")
    .eq("id", candidateId)
    .eq("item_id", itemId)
    .single();

  if (candidateError || !candidate) {
    return NextResponse.json({ error: candidateError?.message || "candidate not found" }, { status: 404 });
  }

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
  return NextResponse.json({ item });
}
