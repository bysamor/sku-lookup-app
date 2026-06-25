import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/app/lib/supabaseServer";

export const dynamic = "force-dynamic";

// 建立一個 lookup job（單個 SKU 或批量 SKU 都走這個 endpoint）
// 1. 寫入 lookup_jobs + lookup_items（狀態 pending）
// 2. 呼叫 Python worker 的 /run-job 觸發實際搜尋（非同步，不等待完成）
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const rawSkus: string[] = Array.isArray(body?.skus) ? body.skus : [];
  const jobName: string = body?.jobName || "SKU Lookup Job";

  const skus = Array.from(
    new Set(rawSkus.map((s) => String(s).trim()).filter(Boolean))
  );

  if (!skus.length) {
    return NextResponse.json({ error: "skus is required" }, { status: 400 });
  }

  const supabase = supabaseServer();

  const { data: job, error: jobError } = await supabase
    .from("lookup_jobs")
    .insert({ job_name: jobName, total_skus: skus.length, processed_skus: 0, status: "pending" })
    .select("*")
    .single();

  if (jobError || !job) {
    return NextResponse.json({ error: jobError?.message || "create job failed" }, { status: 500 });
  }

  const rows = skus.map((sku) => ({ job_id: job.id, sku_code: sku, status: "pending" }));
  const { error: itemsError } = await supabase.from("lookup_items").insert(rows);

  if (itemsError) {
    return NextResponse.json({ error: itemsError.message }, { status: 500 });
  }

  const workerUrl = process.env.WORKER_BASE_URL;
  if (workerUrl) {
    try {
      await fetch(`${workerUrl}/run-job`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: job.id }),
      });
    } catch {
      // worker 暫時連不上也不阻斷 job 建立；前端會顯示 pending，使用者可之後重試。
    }
  }

  return NextResponse.json({ jobId: job.id, total: skus.length });
}

export async function GET() {
  const supabase = supabaseServer();
  const { data, error } = await supabase
    .from("lookup_jobs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ jobs: data });
}
