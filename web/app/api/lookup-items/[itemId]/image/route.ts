import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/app/lib/supabaseServer";

export const dynamic = "force-dynamic";

// 代理下載產品圖片。
// 很多電商網站對圖片有防盜鏈（hotlink protection），瀏覽器直接 <img src="原圖網址">
// 常常因為沒有合法的 Referer / User-Agent 而被拒絕，導致預覽空白。
// 改由伺服器端用一般瀏覽器的 User-Agent 抓圖再轉發給前端，可以繞過大部分防盜鏈限制。
// 加 ?download=1 則回傳 Content-Disposition: attachment，瀏覽器會直接存檔。
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ itemId: string }> }
) {
  const { itemId } = await context.params;
  const download = req.nextUrl.searchParams.get("download") === "1";

  const supabase = supabaseServer();
  const { data: item, error } = await supabase
    .from("lookup_items")
    .select("sku_code, product_image")
    .eq("id", itemId)
    .single();

  if (error || !item?.product_image) {
    return NextResponse.json({ error: "no product_image for this item" }, { status: 404 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(item.product_image, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SKU-Search-App/1.0)",
        Accept: "image/*",
      },
    });
  } catch {
    return NextResponse.json({ error: "failed to fetch image" }, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: `upstream returned ${upstream.status}` }, { status: 502 });
  }

  const contentType = upstream.headers.get("content-type") || "image/jpeg";
  const ext = contentType.split("/")[1]?.split(";")[0] || "jpg";
  const filename = `${item.sku_code}.${ext}`;

  const headers: Record<string, string> = { "Content-Type": contentType };
  if (download) {
    headers["Content-Disposition"] = `attachment; filename="${filename}"`;
  }

  return new NextResponse(upstream.body, { headers });
}
