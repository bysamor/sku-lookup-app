import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/app/lib/supabaseServer";

// 人工編輯繁體中文欄位 / 手動修正狀態
const EDITABLE_FIELDS = [
  "product_name",
  "product_image",
  "benefits",
  "ingredients",
  "direction",
  "country",
  "product_url",
  "source_site",
  "status",
] as const;

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ itemId: string }> }
) {
  const { itemId } = await context.params;
  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const values: Record<string, unknown> = { reviewed: true };
  for (const field of EDITABLE_FIELDS) {
    if (field in body) values[field] = body[field];
  }

  const supabase = supabaseServer();
  const { data, error } = await supabase
    .from("lookup_items")
    .update(values)
    .eq("id", itemId)
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ item: data });
}
