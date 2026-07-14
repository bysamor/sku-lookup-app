/**
 * SKU 全網搜尋 + 擷取（TypeScript 版，移植自 Python worker）
 * 運行在 Vercel Next.js serverless function 內，不需要 Railway。
 */

const SERPAPI_KEY = process.env.SERPAPI_KEY || "";
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || "";
const TRANSLATE_API_KEY = process.env.TRANSLATE_API_KEY || "";
const TRANSLATE_API_BASE = process.env.TRANSLATE_API_BASE || "https://openrouter.ai/api/v1";
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || "openai/gpt-4o-mini";
const EXCLUDE_DOMAINS = (process.env.SEARCH_EXCLUDE_DOMAINS || "")
  .split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);

export interface CandidatePage {
  title: string;
  url: string;
  snippet?: string;
  score: number;
  matched_sku: boolean;
  source_site?: string;
}

export interface ProductResult {
  sku_code: string;
  product_name?: string;
  product_image?: string;
  benefits?: string;
  ingredients?: string;
  direction?: string;
  country?: string;
  product_url?: string;
  source_site?: string;
  status: string;
  candidates: CandidatePage[];
}

// ── Helpers ───────────────────────────────────────────────────────

function extractDomain(url: string): string {
  const m = url.match(/https?:\/\/([^/]+)/);
  return m ? m[1].toLowerCase() : "";
}

function isExcluded(url: string): boolean {
  const d = extractDomain(url);
  return EXCLUDE_DOMAINS.some((ex) => d === ex || d.endsWith(`.${ex}`));
}

function looksLikeChinese(text: string): boolean {
  const chinese = (text.match(/[一-鿿]/g) || []).length;
  const alpha = (text.match(/[A-Za-z一-鿿]/g) || []).length;
  return alpha > 0 && chinese / alpha >= 0.5;
}

function barcodeRegion(sku: string): string {
  if (sku.startsWith("880")) return "kr";
  if (sku.startsWith("471") || sku.startsWith("489")) return "tw";
  if (/^69\d/.test(sku)) return "cn";
  if (sku.startsWith("45") || sku.startsWith("49")) return "jp";
  return "";
}

// ── SerpAPI search ────────────────────────────────────────────────

async function serpSearch(
  query: string,
  { gl = "", hl = "", limit = 5 } = {}
): Promise<CandidatePage[]> {
  const params = new URLSearchParams({
    engine: "google",
    q: query,
    num: String(limit),
    api_key: SERPAPI_KEY,
  });
  if (gl) params.set("gl", gl);
  if (hl) params.set("hl", hl);

  try {
    const res = await fetch(`https://serpapi.com/search.json?${params}`, {
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.organic_results || []).slice(0, limit).map((r: Record<string, string>) => ({
      title: r.title || "",
      url: r.link || "",
      snippet: r.snippet,
      score: 0,
      matched_sku: false,
      source_site: extractDomain(r.link || ""),
    }));
  } catch {
    return [];
  }
}

// ── Fetch HTML ────────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SKU-Search-App/1.0)" },
    signal: AbortSignal.timeout(15000),
  });
  return res.text();
}

// ── Firecrawl ─────────────────────────────────────────────────────

async function fetchFirecrawl(url: string): Promise<string | null> {
  if (!FIRECRAWL_API_KEY) return null;
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
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

// ── Translation ───────────────────────────────────────────────────

async function translateToZhHk(text: string): Promise<string | null> {
  if (!TRANSLATE_API_KEY) return null;
  try {
    const res = await fetch(`${TRANSLATE_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TRANSLATE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TRANSLATE_MODEL,
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

async function bilingualZhHk(text: string | null | undefined): Promise<string | null> {
  if (!text) return null;
  if (text.startsWith("EN:") || text.startsWith("ZH-HK:")) return text;
  if (looksLikeChinese(text)) return text;
  const translated = await translateToZhHk(text);
  if (!translated || translated.trim() === text.trim()) return `EN: ${text}`;
  return `EN: ${text}\nZH-HK: ${translated}`;
}

// ── LLM field extraction ──────────────────────────────────────────

async function llmExtractFields(
  pageText: string,
  sku: string,
  missing: string[]
): Promise<Record<string, string | null>> {
  if (!TRANSLATE_API_KEY || !missing.length) return {};
  const fieldNames: Record<string, string> = {
    benefits: "功效/好處 (benefits)",
    ingredients: "成分 (ingredients)",
    direction: "使用方法 (directions / how to use)",
    country: "原產地 (country of origin)",
  };
  const wanted = missing.filter((k) => fieldNames[k]);
  if (!wanted.length) return {};
  try {
    const res = await fetch(`${TRANSLATE_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TRANSLATE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TRANSLATE_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              `你是電商產品頁面資料擷取助手。從網頁文字（可能是英文、韓文、日文、中文等任何語言）中找出以下欄位：${wanted.map((k) => fieldNames[k]).join("、")}。` +
              `找到的欄位請輸出雙語格式：'EN: <英文原文或英文翻譯>\\nZH-HK: <繁體中文翻譯（香港用語）>'；如果原文已是繁體中文，直接輸出原文。找不到填 null。` +
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
      result[k] =
        v && typeof v === "string" && !["null", "none", "n/a"].includes(v.toLowerCase())
          ? v
          : null;
    }
    return result;
  } catch {
    return {};
  }
}

// ── Scoring ───────────────────────────────────────────────────────

function scoreCandidate(c: CandidatePage, sku: string, html: string): CandidatePage {
  let score = 0;
  const haystack = [c.title, c.snippet || "", html.slice(0, 20000)].join(" ");

  if (haystack.toLowerCase().includes(sku.toLowerCase())) {
    score += 100;
    c.matched_sku = true;
  }
  if (/\/product[s]?\/|\/item\/|\/p\//.test(c.url.toLowerCase())) score += 15;
  if (/amazon|facebook|instagram|youtube|pinterest/.test(c.url.toLowerCase())) score -= 30;
  if (
    /ingredient|benefits|directions|country|sku|成分|功效|使用方法|原產地|성분|효능|사용방법|원산지/i.test(
      haystack
    )
  )
    score += 10;

  c.score = score;
  return c;
}

// ── JSON-LD extraction ────────────────────────────────────────────

function extractJsonLd(html: string): {
  name?: string;
  image?: string;
  description?: string;
  country?: string;
} {
  const matches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of matches) {
    try {
      const obj = JSON.parse(m[1]);
      const products = Array.isArray(obj) ? obj : obj["@graph"] ? obj["@graph"] : [obj];
      for (const p of products) {
        if (p["@type"] === "Product") {
          const img = p.image;
          return {
            name: p.name,
            image: Array.isArray(img) ? img[0]?.url || img[0] : img?.url || img,
            description: p.description,
            country: p.brand?.countryOfOrigin,
          };
        }
      }
    } catch {
      continue;
    }
  }
  return {};
}

function extractMetaImage(html: string): string | null {
  const og = html.match(/property=["']og:image["'][^>]+content=["']([^"']+)/i);
  if (og) return og[1];
  const tw = html.match(/name=["']twitter:image["'][^>]+content=["']([^"']+)/i);
  if (tw) return tw[1];
  return null;
}

function extractH1(html: string): string | null {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return null;
  return m[1].replace(/<[^>]+>/g, "").trim() || null;
}

function extractLabeledBlock(text: string, labels: string[]): string | null {
  for (const label of labels) {
    const re = new RegExp(
      `(?:^|\\n)\\s*(?:\\*{0,2})${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\*{0,2})\\s*[:\\-]?\\s*([^\\n]{10,})`,
      "im"
    );
    const m = text.match(re);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return null;
}

// ── Parse product page ────────────────────────────────────────────

async function parseProductPage(
  url: string,
  sku: string,
  html?: string
): Promise<Record<string, string | null>> {
  const pageHtml = html || (await fetchHtml(url).catch(() => ""));
  const rendered = await fetchFirecrawl(url);
  const pageText = [pageHtml.replace(/<[^>]+>/g, " "), rendered || ""].join("\n\n");

  const ld = extractJsonLd(pageHtml);
  const name = ld.name || extractH1(pageHtml) || null;
  const image = ld.image || extractMetaImage(pageHtml) || null;

  let benefits: string | null = ld.description || null;
  let ingredients: string | null = null;
  let direction: string | null = null;
  let country: string | null = ld.country || null;

  benefits =
    benefits ||
    extractLabeledBlock(pageText, ["Benefits", "好處", "功效", "特色", "特點", "효능", "특징"]);
  ingredients =
    ingredients ||
    extractLabeledBlock(pageText, [
      "Ingredients",
      "Main Ingredients",
      "成分",
      "原料",
      "성분",
      "원재료",
    ]);
  direction =
    direction ||
    extractLabeledBlock(pageText, [
      "Directions",
      "Direction",
      "How to use",
      "Feeding Guide",
      "使用方法",
      "食用方法",
      "用法",
      "사용방법",
      "급여방법",
    ]);
  country =
    country ||
    extractLabeledBlock(pageText, [
      "Country of Origin",
      "Made in",
      "原產地",
      "产地",
      "원산지",
      "제조국",
    ]);

  // LLM fallback for missing fields
  const missing = (["benefits", "ingredients", "direction", "country"] as const).filter(
    (k) => !{ benefits, ingredients, direction, country }[k]
  );
  if (missing.length && pageText.trim()) {
    const extra = await llmExtractFields(pageText, sku, [...missing]);
    if (!benefits && extra.benefits) benefits = extra.benefits;
    if (!ingredients && extra.ingredients) ingredients = extra.ingredients;
    if (!direction && extra.direction) direction = extra.direction;
    if (!country && extra.country) country = extra.country;
  }

  // Bilingual translation (parallel)
  const [bBil, iBil, dBil, cBil] = await Promise.all([
    bilingualZhHk(benefits),
    bilingualZhHk(ingredients),
    bilingualZhHk(direction),
    bilingualZhHk(country),
  ]);

  return {
    name: name ? (await translateToZhHk(name)) || name : null,
    image,
    benefits: bBil,
    ingredients: iBil,
    direction: dBil,
    country: cBil,
  };
}

// ── Merge missing fields from other candidates ─────────────────────

async function mergeMissingFields(
  primary: Record<string, string | null>,
  candidates: CandidatePage[],
  excludeUrl: string,
  sku: string
): Promise<Record<string, string | null>> {
  const mergeFields = ["benefits", "ingredients", "direction", "country"];
  let missing = mergeFields.filter((f) => !primary[f]);
  if (!missing.length) return primary;

  for (const c of candidates.slice(0, 3)) {
    if (!missing.length) break;
    if (c.url === excludeUrl) continue;
    try {
      const extra = await parseProductPage(c.url, sku);
      for (const f of [...missing]) {
        if (extra[f]) {
          primary[f] = extra[f];
          missing = missing.filter((m) => m !== f);
        }
      }
    } catch {
      continue;
    }
  }
  return primary;
}

// ── GS1 lookup fallback ───────────────────────────────────────────

interface Gs1Result {
  productName?: string;
  brandName?: string;
  imageUrl?: string;
  countryOfSale?: string;
}

async function lookupGs1(sku: string): Promise<Gs1Result> {
  const gs1Url = `https://www.gs1.org/services/verified-by-gs1?gtin=${sku}`;
  try {
    // Scrape the GS1 page with Firecrawl (it's a JS-rendered page)
    const markdown = await fetchFirecrawl(gs1Url);
    if (!markdown) return {};

    // Extract fields from GS1 markdown
    const extract = (labels: string[]): string | undefined => {
      for (const label of labels) {
        const re = new RegExp(
          `${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[|:\\n]+\\s*([^\\n|]{2,})`,
          "i"
        );
        const m = markdown.match(re);
        if (m?.[1]?.trim() && !["unknown", "n/a", "-"].includes(m[1].trim().toLowerCase())) {
          return m[1].trim();
        }
      }
      return undefined;
    };

    const productName = extract(["Product description", "Product name"]);
    const brandName = extract(["Brand name", "Brand"]);
    const countryOfSale = extract(["Country of sale", "Country"]);

    // GS1 rarely has images, but try extracting image URL from markdown
    const imgMatch = markdown.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/);
    const imageUrl = imgMatch?.[1];

    return {
      productName: productName || undefined,
      brandName: brandName || undefined,
      imageUrl: imageUrl || undefined,
      countryOfSale: countryOfSale || undefined,
    };
  } catch {
    return {};
  }
}

// ── Main SKU lookup ────────────────────────────────────────────────

export async function lookupSku(sku: string): Promise<ProductResult> {
  const excludeSuffix = EXCLUDE_DOMAINS.map((d) => `-site:${d}`).join(" ");
  const region = barcodeRegion(sku);

  const baseQueries = [sku, `"${sku}" product`, `"${sku}" sku`];
  type RegionQuery = { q: string; gl?: string; hl?: string };
  const extraQueries: RegionQuery[] =
    region === "kr"
      ? [
          { q: `"${sku}" 제품`, gl: "kr", hl: "ko" },
          { q: `"${sku}" 상품`, gl: "kr", hl: "ko" },
        ]
      : region === "tw"
      ? [
          { q: `"${sku}" 產品`, gl: "tw", hl: "zh-TW" },
          { q: `"${sku}" 商品`, gl: "hk", hl: "zh-TW" },
        ]
      : region === "cn"
      ? [{ q: `"${sku}" 产品`, gl: "cn", hl: "zh-CN" }]
      : region === "jp"
      ? [{ q: `"${sku}" 製品`, gl: "jp", hl: "ja" }]
      : [{ q: `"${sku}" 產品`, gl: "hk", hl: "zh-TW" }];

  const seen = new Set<string>();
  let candidates: CandidatePage[] = [];

  // Run all queries in parallel
  const allQueries: RegionQuery[] = [
    ...baseQueries.map((q) => ({ q: excludeSuffix ? `${q} ${excludeSuffix}` : q })),
    ...extraQueries.map((eq) => ({
      ...eq,
      q: excludeSuffix ? `${eq.q} ${excludeSuffix}` : eq.q,
    })),
  ];

  const searchResults = await Promise.all(
    allQueries.map(({ q, gl, hl }) => serpSearch(q, { gl, hl, limit: 5 }))
  );

  for (const results of searchResults) {
    for (const c of results) {
      if (c.url && !seen.has(c.url) && !isExcluded(c.url)) {
        seen.add(c.url);
        candidates.push(c);
      }
    }
  }

  if (!candidates.length) {
    // Fallback: try GS1 to get product name, then re-search with that name
    const gs1 = await lookupGs1(sku);
    const gs1Name = [gs1.brandName, gs1.productName].filter(Boolean).join(" ").trim();

    if (gs1Name) {
      const gs1Queries = [gs1Name, `${gs1Name} product`, `${gs1Name} ingredients`];
      const gs1Results = await Promise.all(
        gs1Queries.map((q) => serpSearch(q, { limit: 5 }))
      );
      for (const results of gs1Results) {
        for (const c of results) {
          if (c.url && !seen.has(c.url) && !isExcluded(c.url)) {
            seen.add(c.url);
            candidates.push(c);
          }
        }
      }

      // If still no candidates, return GS1 data directly as best-effort
      if (!candidates.length) {
        const nameZh = gs1Name ? (await translateToZhHk(gs1Name)) || gs1Name : undefined;
        const countryZh = gs1.countryOfSale
          ? (await translateToZhHk(gs1.countryOfSale)) || gs1.countryOfSale
          : undefined;
        return {
          sku_code: sku,
          product_name: nameZh,
          product_image: gs1.imageUrl || undefined,
          country: countryZh,
          product_url: `https://www.gs1.org/services/verified-by-gs1?gtin=${sku}`,
          source_site: "gs1.org",
          status: "needs_review",
          candidates: [],
        };
      }
    } else {
      return { sku_code: sku, status: "not_found", candidates: [] };
    }
  }

  // Score candidates in parallel (fetch HTML for each)
  const scored = await Promise.all(
    candidates.map(async (c) => {
      try {
        const html = await fetchHtml(c.url);
        return { c: scoreCandidate(c, sku, html), html };
      } catch {
        return { c, html: "" };
      }
    })
  );

  const ranked = scored
    .map(({ c }) => c)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  const best = ranked[0];
  if (!best) {
    return { sku_code: sku, status: "not_found", candidates: ranked };
  }

  const bestHtml = scored.find(({ c }) => c.url === best.url)?.html || "";

  try {
    let parsed = await parseProductPage(best.url, sku, bestHtml);
    parsed = await mergeMissingFields(parsed, ranked, best.url, sku);

    const status =
      best.score >= 50 && best.matched_sku ? "found" : "needs_review";

    return {
      sku_code: sku,
      product_name: parsed.name || undefined,
      product_image: parsed.image || undefined,
      benefits: parsed.benefits || undefined,
      ingredients: parsed.ingredients || undefined,
      direction: parsed.direction || undefined,
      country: parsed.country || undefined,
      product_url: best.url,
      source_site: best.source_site,
      status,
      candidates: ranked,
    };
  } catch {
    return {
      sku_code: sku,
      product_url: best.url,
      source_site: best.source_site,
      status: "needs_review",
      candidates: ranked,
    };
  }
}
