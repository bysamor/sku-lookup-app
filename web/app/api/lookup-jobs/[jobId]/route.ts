import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/app/lib/supabaseServer";

// job 進度會持續變化，這個 route 不能被 Next.js 的 Full Route Cache 快取
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await context.params;
  const supabase = supabaseServer();

  const { data: job, error: jobError } = await supabase
    .from("lookup_jobs")
    .select("*")
    .eq("id", jobId)
    .single();

  if (jobError) {
    return NextResponse.json({ error: jobError.message }, { status: 500 });
  }

  const { data: items, error: itemsError } = await supabase
    .from("lookup_items")
    .select("*, lookup_candidates!lookup_candidates_item_id_fkey(*)")
    .eq("job_id", jobId)
    .order("created_at", { ascending: true });

  if (itemsError) {
    return NextResponse.json({ error: itemsError.message }, { status: 500 });
  }

  return NextResponse.json({ job, items });
}
