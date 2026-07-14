import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/app/lib/supabaseServer";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ── 內容提取工具函式 ──────────────────────────────────────────────

function looksLikeChinese(text: string): boolean {
  const chinese = (text.match(/[一-鿿]/g) || []).length;
  const alpha = (text.match(/[A-Za-z一-鿿]/g) || []).length;
  return alpha > 0 && chinese / alpha >= 0.5;
}

async function fetchFirecrawl(url: string): Promise<string | null> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.markdown || null;
  } catch {
    return null;
  }
}

async function translateToZhHk(text: string): Promise<string | null> {
  const key = process.env.TRANSLATE_API_KEY;
  const base = process.env.TRANSLATE_API_BASE || "https://openrouter.ai/api/v1";
  const model = process.env.TRANSLATE_MODEL || "openai/gpt-4o-mini";
  if (!key) return null;
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "你是專業翻譯。請將使用者提供的文字翻譯成繁體中文（香港用語，zh-HK），保留原意與專業術語，不要加任何解釋、引號或前後綴，只輸出翻譯結果。如果原文已經是繁體中文，原樣輸出。",
          },
          { role: "user", content: text },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

async function bilingualZhHk(text: string | null): Promise<string | null> {
  if (!text) return null;
  if (looksLikeChinese(text)) return text;
  const translated = await translateToZhHk(text);
  if (!translated || translated.trim() === text.trim()) return `EN: ${text}`;
  return `EN: ${text}\nZH-HK: ${translated}`;
}

function extractField(text: string, keywords: string[]): string | null {
  for (const kw of keywords) {
    const re = new RegExp(
      `(?:^|\\n)\\s*(?:\\*{0,2})${kw}(?:\\*{0,2})\\s*[:\\-]?\\s*([^\\n]{10,})`,
      "im"
    );
    const m = text.match(re);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return null;
}

async function llmExtractFields(
  pageText: string,
  sku: string,
  missing: string[]
): Promise<Record<string, string | null>> {
  const key = process.env.TRANSLATE_API_KEY;
  const base = process.env.TRANSLATE_API_BASE || "https://openrouter.ai/api/v1";
  const model = process.env.TRANSLATE_MODEL || "openai/gpt-4o-mini";
  if (!key || !missing.length) return {};

  const fieldNames: Record<string, string> = {
    benefits: "功效/好處 (benefits)",
    ingredients: "成分 (ingredients)",
    direction: "使用方法 (directions / how to use)",
    country: "原產地 (country of origin)",
  };
  const wanted = missing.filter((k) => fieldNames[k]);
  if (!wanted.length) return {};

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              `你是電商產品頁面資料擷取助手。從網頁文字中找出以下欄位：${wanted.map((k) => fieldNames[k]).join("、")}。` +
              `找到的欄位請輸出雙語格式：如果原文是英文，輸出 "EN: <原文>\\nZH-HK: <繁體中文翻譯，香港用語>"；如果原文已是中文，直接輸出原文。找不到填 null。` +
              `只輸出 JSON 物件，key 為 ${wanted.map((k) => `"${k}"`).join(", ")}。`,
          },
          { role: "user", content: `SKU: ${sku}\n\n網頁文字：\n${pageText.slice(0, 16000)}` },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const raw = JSON.parse(data?.choices?.[0]?.message?.content || "{}");
    const result: Record<string, string | null> = {};
    for (const k of wanted) {
      const v = raw[k];
      result[k] = v && typeof v === "string" && !["null", "none", "n/a"].includes(v.toLowerCase())
        ? v
        : null;
    }
    return result;
  } catch {
    return {};
  }
}

async function extractFromPage(
  url: string,
  sku: string
): Promise<{
  name: string | null;
  image: string | null;
  benefits: string | null;
  ingredients: string | null;
  direction: string | null;
  country: string | null;
}> {
  const pageText = (await fetchFirecrawl(url)) || "";

  // 關鍵字提取
  let benefits = extractField(pageText, ["Benefits", "好處", "功效", "特色", "特點"]);
  let ingredients = extractField(pageText, ["Ingredients", "Main Ingredients", "成分"]);
  let direction = extractField(pageText, [
    "Directions", "How to Use", "Usage", "使用方法", "使用指示",
  ]);
  let country = extractField(pageText, [
    "Country of Origin", "Made in", "原產地", "產地",
  ]);

  // LLM fallback 補齊還缺的欄位
  const missing = (["benefits", "ingredients", "direction", "country"] as const).filter(
    (k) =>
      !{ benefits, ingredients, direction, country }[k]
  );
  if (missing.length && pageText) {
    const extra = await llmExtractFields(pageText, sku, [...missing]);
    if (!benefits && extra.benefits) benefits = extra.benefits;
    if (!ingredients && extra.ingredients) ingredients = extra.ingredients;
    if (!direction && extra.direction) direction = extra.direction;
    if (!country && extra.country) country = extra.country;
  }

  // 雙語翻譯（已含 EN: / ZH-HK: 的跳過）
  const [bBil, iBil, dBil, cBil] = await Promise.all([
    benefits && !benefits.startsWith("EN:") && !benefits.startsWith("ZH-HK:")
      ? bilingualZhHk(benefits)
      : Promise.resolve(benefits),
    ingredients && !ingredients.startsWith("EN:") && !ingredients.startsWith("ZH-HK:")
      ? bilingualZhHk(ingredients)
      : Promise.resolve(ingredients),
    direction && !direction.startsWith("EN:") && !direction.startsWith("ZH-HK:")
      ? bilingualZhHk(direction)
      : Promise.resolve(direction),
    country && !country.startsWith("EN:") && !country.startsWith("ZH-HK:")
      ? bilingualZhHk(country)
      : Promise.resolve(country),
  ]);

  return {
    name: null,
    image: null,
    benefits: bBil,
    ingredients: iBil,
    direction: dBil,
    country: cBil,
  };
}

// ── Main handler ──────────────────────────────────────────────────

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
    .select("*, lookup_items!lookup_candidates_item_id_fkey(sku_code)")
    .eq("id", candidateId)
    .eq("item_id", itemId)
    .single();

  if (candidateError || !candidate) {
    return NextResponse.json(
      { error: candidateError?.message || "candidate not found" },
      { status: 404 }
    );
  }

  // 立即切換候選標記
  await supabase.from("lookup_candidates").update({ is_selected: false }).eq("item_id", itemId);
  await supabase.from("lookup_candidates").update({ is_selected: true }).eq("id", candidateId);

  // 先用候選的 URL / source_site 更新 item，讓前端立即看到切換
  await supabase
    .from("lookup_items")
    .update({
      best_candidate_id: candidateId,
      product_url: candidate.url,
      source_site: candidate.source_site,
      status: "needs_review",
      reviewed: true,
    })
    .eq("id", itemId);

  // 從候選頁重新提取內容（在同一個請求內完成，maxDuration=60s）
  const sku = (candidate as { lookup_items?: { sku_code?: string } }).lookup_items?.sku_code || "";
  let extracted = null;
  if (candidate.url && sku) {
    try {
      extracted = await extractFromPage(candidate.url, sku);
    } catch {
      // 提取失敗不阻斷，保留舊欄位
    }
  }

  if (extracted) {
    const patch: Record<string, string | null> = {
      product_url: candidate.url,
      source_site: candidate.source_site,
    };
    if (extracted.benefits) patch.benefits = extracted.benefits;
    if (extracted.ingredients) patch.ingredients = extracted.ingredients;
    if (extracted.direction) patch.direction = extracted.direction;
    if (extracted.country) patch.country = extracted.country;

    await supabase.from("lookup_items").update(patch).eq("id", itemId);
  }

  const { data: item } = await supabase
    .from("lookup_items")
    .select("*")
    .eq("id", itemId)
    .single();

  return NextResponse.json({ item, extracted: !!extracted });
}
