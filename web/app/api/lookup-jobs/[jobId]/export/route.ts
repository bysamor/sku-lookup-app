import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/app/lib/supabaseServer";

const HEADERS = [
  "SKU編號",
  "產品名稱",
  "產品圖片",
  "功效/好處",
  "成分",
  "使用方法",
  "原產地",
  "產品網址",
  "來源網站",
  "狀態",
];

const STATUS_LABEL: Record<string, string> = {
  pending: "待處理",
  found: "已找到",
  needs_review: "待人工確認",
  not_found: "未找到",
  failed: "失敗",
};

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await context.params;
  const supabase = supabaseServer();

  const { data: items, error } = await supabase
    .from("lookup_items")
    .select("*")
    .eq("job_id", jobId)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const lines = [HEADERS.join(",")];
  for (const item of items || []) {
    lines.push(
      [
        item.sku_code,
        item.product_name,
        item.product_image,
        item.benefits,
        item.ingredients,
        item.direction,
        item.country,
        item.product_url,
        item.source_site,
        STATUS_LABEL[item.status] || item.status,
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  // 加 BOM 確保 Excel 開啟繁體中文不會變亂碼
  const csv = "﻿" + lines.join("\n");

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="sku-lookup-${jobId}.csv"`,
    },
  });
}
