"""
SKU 全網搜尋 + 擷取 worker（MVP）

流程：
1. 用 SKU 做 web search（SerpAPI）
2. 抓取候選頁面 HTML，計分排序（SKU 完全匹配優先）
3. 從最佳候選頁擷取欄位（JSON-LD Product 優先，其次關鍵字區塊）
4. 全部欄位翻譯為繁體中文 (zh-HK)
5. 回傳最佳結果 + 候選列表，供前端人工確認/覆寫
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, asdict, field
from typing import List, Optional, Dict, Any

import requests
from bs4 import BeautifulSoup

USER_AGENT = "Mozilla/5.0 (compatible; SKU-Search-App/1.0)"
HEADERS = {"User-Agent": USER_AGENT}
REQUEST_TIMEOUT = 25

# Firecrawl：用真實瀏覽器渲染頁面再回傳乾淨文字，能抓到 requests 抓不到的
# JS 動態載入內容（例如分頁籤裡的 Directions/Benefits）。沒設定 key 則跳過，
# 退回原本只用 requests 抓靜態 HTML 的行為。
FIRECRAWL_API_KEY = os.getenv("FIRECRAWL_API_KEY", "").strip()
FIRECRAWL_API_BASE = os.getenv("FIRECRAWL_API_BASE", "https://api.firecrawl.dev/v1").strip()
FIRECRAWL_TIMEOUT = 30

# 候選分數低於此門檻 -> 視為「待人工確認」而非「已找到」
MIN_CONFIDENT_SCORE = 50.0

# 排除自家網域（例如客戶自己就是 petline.com.hk，查自己的 SKU 不需要撈回自己網站）
# 用逗號分隔多個網域，例如 "petline.com.hk,www.petline.com.hk"
EXCLUDE_DOMAINS = [
    d.strip().lower()
    for d in os.getenv("SEARCH_EXCLUDE_DOMAINS", "").split(",")
    if d.strip()
]


def is_excluded_domain(url: str) -> bool:
    domain = (extract_domain(url) or "").lower()
    return any(domain == d or domain.endswith(f".{d}") for d in EXCLUDE_DOMAINS)


@dataclass
class CandidatePage:
    title: str
    url: str
    snippet: Optional[str] = None
    score: float = 0.0
    matched_sku: bool = False
    source_site: Optional[str] = None


@dataclass
class ProductResult:
    sku_code: str
    product_name: Optional[str] = None
    product_image: Optional[str] = None
    benefits: Optional[str] = None
    ingredients: Optional[str] = None
    direction: Optional[str] = None
    country: Optional[str] = None
    product_url: Optional[str] = None
    source_site: Optional[str] = None
    status: str = "未找到"  # 已找到 | 待人工確認 | 未找到
    candidates: List[Dict[str, Any]] = field(default_factory=list)


class SearchProvider:
    def search(self, query: str, limit: int = 5) -> List[CandidatePage]:
        raise NotImplementedError


class SerpApiSearchProvider(SearchProvider):
    def __init__(self, api_key: str):
        self.api_key = api_key

    def search(self, query: str, limit: int = 5) -> List[CandidatePage]:
        url = "https://serpapi.com/search.json"
        params = {
            "engine": "google",
            "q": query,
            "num": limit,
            "api_key": self.api_key,
        }
        r = requests.get(url, params=params, headers=HEADERS, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        data = r.json()

        results = []
        for item in data.get("organic_results", [])[:limit]:
            link = item.get("link", "")
            results.append(
                CandidatePage(
                    title=item.get("title", ""),
                    url=link,
                    snippet=item.get("snippet"),
                    source_site=extract_domain(link),
                )
            )
        return results


def extract_domain(url: str) -> Optional[str]:
    m = re.search(r"https?://([^/]+)", url)
    return m.group(1).lower() if m else None


def fetch_html(url: str) -> str:
    r = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    return r.text


def fetch_rendered_text(url: str) -> Optional[str]:
    """用 Firecrawl 渲染頁面後回傳乾淨的 markdown 文字。沒設 FIRECRAWL_API_KEY
    或呼叫失敗時回 None，呼叫端應該退回用 requests 抓到的靜態文字。"""
    if not FIRECRAWL_API_KEY:
        return None
    try:
        resp = requests.post(
            f"{FIRECRAWL_API_BASE}/scrape",
            headers={
                "Authorization": f"Bearer {FIRECRAWL_API_KEY}",
                "Content-Type": "application/json",
            },
            json={"url": url, "formats": ["markdown"], "onlyMainContent": True},
            timeout=FIRECRAWL_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        markdown = (data.get("data") or {}).get("markdown")
        return markdown or None
    except Exception:
        return None


def clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def find_jsonld_products(soup: BeautifulSoup) -> List[dict]:
    items = []
    for script in soup.select('script[type="application/ld+json"]'):
        raw = script.get_text(strip=True)
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except Exception:
            continue
        objs = data if isinstance(data, list) else [data]
        for obj in objs:
            if isinstance(obj, dict):
                items.extend(flatten_jsonld(obj))
    return [x for x in items if is_product_like(x)]


def flatten_jsonld(obj: dict) -> List[dict]:
    found = []

    def walk(node):
        if isinstance(node, dict):
            found.append(node)
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for i in node:
                walk(i)

    walk(obj)
    return found


def is_product_like(obj: dict) -> bool:
    t = obj.get("@type")
    if isinstance(t, list):
        return "Product" in t
    return t == "Product"


def normalize_image(value: Any) -> Optional[str]:
    if isinstance(value, str):
        return value
    if isinstance(value, list) and value:
        if isinstance(value[0], str):
            return value[0]
        if isinstance(value[0], dict):
            return value[0].get("url") or value[0].get("contentUrl")
    if isinstance(value, dict):
        return value.get("url") or value.get("contentUrl")
    return None


def extract_meta_image(soup: BeautifulSoup) -> Optional[str]:
    for selector, attr in [
        ('meta[property="og:image"]', "content"),
        ('meta[name="twitter:image"]', "content"),
    ]:
        el = soup.select_one(selector)
        if el and el.get(attr):
            return el.get(attr)
    img = soup.select_one("img")
    if img:
        return img.get("src") or img.get("data-src")
    return None


def contains_sku(text: str, sku: str) -> bool:
    if not text or not sku:
        return False
    return sku.lower() in text.lower()


def score_candidate(candidate: CandidatePage, sku: str, html: str) -> float:
    score = 0.0
    haystack = " ".join([candidate.title or "", candidate.snippet or "", html[:20000]])

    if contains_sku(haystack, sku):
        score += 100
        candidate.matched_sku = True

    if any(seg in candidate.url.lower() for seg in ["/product/", "/products/", "/item/", "/p/"]):
        score += 15

    if any(x in candidate.url.lower() for x in ["amazon", "facebook", "instagram", "youtube", "pinterest"]):
        score -= 30

    if any(x in haystack.lower() for x in ["ingredient", "ingredients", "benefits", "directions", "country", "sku", "成分", "功效", "使用方法", "原產地"]):
        score += 10

    return score


def extract_labeled_block(text: str, labels: List[str]) -> Optional[str]:
    lines = [clean_text(x) for x in text.splitlines() if clean_text(x)]
    for i, line in enumerate(lines):
        lower = line.lower()
        for label in labels:
            if label.lower() in lower:
                block = [line]
                for j in range(i + 1, min(i + 4, len(lines))):
                    if len(lines[j]) < 220:
                        block.append(lines[j])
                return " ".join(block)
    return None


# ---------------------------------------------------------------------------
# 翻譯為繁體中文 (zh-HK)
#
# 預設使用 Anthropic / OpenAI 相容的 Chat Completions API（透過環境變數設定）。
# 若未設定 TRANSLATE_API_KEY，則原文照搬（不翻譯），方便本地開發/測試。
# ---------------------------------------------------------------------------

_TRANSLATE_API_KEY = os.getenv("TRANSLATE_API_KEY", "").strip()
_TRANSLATE_API_BASE = os.getenv("TRANSLATE_API_BASE", "https://api.openai.com/v1").strip()
_TRANSLATE_MODEL = os.getenv("TRANSLATE_MODEL", "gpt-4o-mini").strip()


def _looks_like_chinese(text: str) -> bool:
    # 只有當中文字佔所有字母類字元 50% 以上才視為中文，避免混有少量中文標題的英文內容跳過翻譯
    chinese_chars = len(re.findall(r"[一-鿿]", text))
    alpha_chars = len(re.findall(r"[A-Za-z一-鿿]", text))
    if alpha_chars == 0:
        return False
    return chinese_chars / alpha_chars >= 0.5


def translate_to_zh_hk(text: Optional[str]) -> Optional[str]:
    if not text:
        return text

    # 已經是中文（簡或繁）就不必呼叫翻譯 API，省成本；簡轉繁可由前端編輯時人工修正。
    if not _TRANSLATE_API_KEY:
        return text

    try:
        resp = requests.post(
            f"{_TRANSLATE_API_BASE}/chat/completions",
            headers={
                "Authorization": f"Bearer {_TRANSLATE_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": _TRANSLATE_MODEL,
                "temperature": 0,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "你是專業翻譯。請將使用者提供的文字翻譯成繁體中文（香港用語，zh-HK），"
                            "保留原意與專業術語，不要加任何解釋、引號或前後綴，只輸出翻譯結果。"
                            "如果原文已經是繁體中文，原樣輸出。"
                        ),
                    },
                    {"role": "user", "content": text},
                ],
            },
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        translated = data["choices"][0]["message"]["content"].strip()
        return translated or text
    except Exception:
        # 翻譯失敗時保留原文，不阻斷整個流程
        return text


def bilingual_zh_hk(text: Optional[str]) -> Optional[str]:
    """功效/成分/使用方法/原產地 用：原文已是中文則照原樣；若原文是英文，輸出 EN + ZH-HK 雙語。"""
    if not text:
        return text
    if _looks_like_chinese(text):
        return text

    translated = translate_to_zh_hk(text)
    if not translated or translated.strip() == text.strip():
        # 沒設 TRANSLATE_API_KEY 或翻譯失敗時，至少保留英文原文
        return f"EN: {text}"
    return f"EN: {text}\nZH-HK: {translated}"


def llm_extract_missing_fields(page_text: str, sku: str, missing: List[str]) -> Dict[str, Optional[str]]:
    """關鍵字比對抓不到的欄位，改用 LLM 直接讀網頁文字抽取（順便雙語輸出）。

    比關鍵字比對更能處理：措辭不同（例如 "How to Use" vs "Directions"）、
    表格/分頁籤排版、欄位順序不固定等情況。網頁是 JS 動態渲染的話依然抓不到
    （因為我們只抓靜態 HTML），這種狀況不在這個函式的修正範圍內。
    """
    if not missing or not _TRANSLATE_API_KEY:
        return {}

    field_names = {
        "benefits": "功效/好處 (benefits)",
        "ingredients": "成分 (ingredients)",
        "direction": "使用方法 (directions / how to use)",
        "country": "原產地 (country of origin)",
    }
    wanted = {k: field_names[k] for k in missing if k in field_names}
    if not wanted:
        return {}

    try:
        resp = requests.post(
            f"{_TRANSLATE_API_BASE}/chat/completions",
            headers={
                "Authorization": f"Bearer {_TRANSLATE_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": _TRANSLATE_MODEL,
                "temperature": 0,
                "response_format": {"type": "json_object"},
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "你是電商產品頁面資料擷取助手。使用者會給你一個產品網頁的純文字內容和 SKU 編號，"
                            "請從文字中找出以下欄位的內容（如果有的話）：" + "、".join(wanted.values()) + "。"
                            "找到的欄位請輸出雙語格式：如果原文是英文，輸出 'EN: <原文>\\nZH-HK: <繁體中文翻譯，香港用語>'；"
                            "如果原文已經是中文，直接輸出原文。找不到的欄位請填 null。"
                            "只輸出 JSON 物件，key 為 " + ", ".join(f'"{k}"' for k in wanted) + "，不要任何其他文字。"
                        ),
                    },
                    {"role": "user", "content": f"SKU: {sku}\n\n網頁文字內容：\n{page_text[:16000]}"},
                ],
            },
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"]
        parsed = json.loads(content)

        def is_real_value(v: Any) -> bool:
            # LLM 有時會把 JSON null 誤寫成字串 "null"/"none"，要當作沒找到
            return bool(v) and isinstance(v, str) and v.strip().lower() not in ("null", "none", "n/a")

        return {k: parsed.get(k) for k in wanted if is_real_value(parsed.get(k))}
    except Exception:
        # LLM 抽取失敗時不阻斷整個流程，缺的欄位維持空白
        return {}


def parse_product_page(url: str, sku: str, html: Optional[str] = None) -> Dict[str, Optional[str]]:
    if html is None:
        html = fetch_html(url)
    soup = BeautifulSoup(html, "html.parser")
    page_text = soup.get_text("\n", strip=True)

    # JSON-LD/meta image 還是讀靜態 HTML（不需要渲染）。關鍵字比對/LLM 抽取用的
    # page_text 疊加 Firecrawl 渲染後的文字（不是取代）——Firecrawl 的
    # onlyMainContent 有時會把含有用資料的區塊過濾掉，疊加才不會比純 requests
    # 漏資訊，同時補上 JS 動態載入、靜態 HTML 抓不到的內容（例如分頁籤裡的
    # Directions/Benefits）。
    rendered_text = fetch_rendered_text(url)
    if rendered_text:
        page_text = page_text + "\n\n" + rendered_text

    name = None
    image = None
    country = None
    benefits = None
    ingredients = None
    direction = None

    for p in find_jsonld_products(soup):
        sku_value = str(p.get("sku", "")).strip()
        gtin_values = [str(p.get(k, "")).strip() for k in ["gtin", "gtin12", "gtin13", "gtin14", "mpn"]]
        if sku == sku_value or sku in gtin_values or contains_sku(json.dumps(p, ensure_ascii=False), sku):
            name = p.get("name") or name
            image = normalize_image(p.get("image")) or image
            desc = p.get("description")
            if desc and not benefits:
                benefits = desc
            brand = p.get("brand")
            if isinstance(brand, dict):
                country = brand.get("countryOfOrigin") or country

    if not name:
        h1 = soup.select_one("h1")
        if h1:
            name = clean_text(h1.get_text(" ", strip=True))

    if not image:
        image = extract_meta_image(soup)

    benefits = benefits or extract_labeled_block(page_text, ["Benefits", "好處", "功效", "特色", "特點"])
    ingredients = ingredients or extract_labeled_block(page_text, ["Ingredients", "Main Ingredients", "成分"])
    direction = direction or extract_labeled_block(page_text, ["Directions", "Direction", "How to use", "Feeding Guide", "使用方法", "食用方法"])
    country = country or extract_labeled_block(page_text, ["Country", "Country of Origin", "Brand Country", "原產地"])

    fields = {"benefits": benefits, "ingredients": ingredients, "direction": direction, "country": country}
    bilingual_fields = {k: bilingual_zh_hk(v) for k, v in fields.items()}

    still_missing = [k for k, v in bilingual_fields.items() if not v]
    if still_missing:
        llm_filled = llm_extract_missing_fields(page_text, sku, still_missing)
        bilingual_fields.update(llm_filled)

    return {
        "name": translate_to_zh_hk(name),
        "image": image,
        "benefits": bilingual_fields["benefits"],
        "ingredients": bilingual_fields["ingredients"],
        "direction": bilingual_fields["direction"],
        "country": bilingual_fields["country"],
        "html": html,
    }


# 最佳結果頁缺欄位時，最多再多看幾個候選頁來補（避免每個 SKU 都把全部候選抓一輪，控制時間/成本）
MAX_EXTRA_CANDIDATES_FOR_MERGE = 3
MERGE_FIELDS = ["benefits", "ingredients", "direction", "country"]


def merge_missing_fields_from_candidates(
    primary: Dict[str, Optional[str]],
    candidates: List[CandidatePage],
    exclude_url: str,
    sku: str,
    max_extra: int = MAX_EXTRA_CANDIDATES_FOR_MERGE,
) -> Dict[str, Optional[str]]:
    """產品名稱/圖片/網址都鎖定最佳結果頁，但功效/成分/使用方法/原產地這幾個
    內容欄位，最佳結果頁沒有的話，依分數順序去看其他候選頁有沒有，哪個候選頁
    有資料就補上，全部候選頁都沒有才真的留空。"""
    missing = [f for f in MERGE_FIELDS if not primary.get(f)]
    if not missing:
        return primary

    tried = 0
    for c in candidates:
        if tried >= max_extra or not missing:
            break
        if c.url == exclude_url:
            continue
        tried += 1
        try:
            extra = parse_product_page(c.url, sku)
        except Exception:
            continue
        for field in list(missing):
            if extra.get(field):
                primary[field] = extra[field]
                missing.remove(field)
        time.sleep(0.5)

    return primary


def choose_best_candidate(candidates: List[CandidatePage], sku: str) -> tuple[Optional[CandidatePage], Optional[str]]:
    best: Optional[CandidatePage] = None
    best_html: Optional[str] = None

    for c in candidates:
        try:
            html = fetch_html(c.url)
            c.score = score_candidate(c, sku, html)
            if best is None or c.score > best.score:
                best = c
                best_html = html
            time.sleep(0.8)
        except Exception:
            continue

    return best, best_html


def lookup_sku(sku: str, search_provider: SearchProvider) -> ProductResult:
    sku = clean_text(sku)

    exclude_suffix = " ".join(f"-site:{d}" for d in EXCLUDE_DOMAINS)
    base_queries = [sku, f'"{sku}" product', f'"{sku}" sku']
    queries = [f"{q} {exclude_suffix}".strip() for q in base_queries] if exclude_suffix else base_queries

    candidates: List[CandidatePage] = []
    seen = set()

    for q in queries:
        try:
            for c in search_provider.search(q, limit=5):
                if c.url and c.url not in seen and not is_excluded_domain(c.url):
                    seen.add(c.url)
                    candidates.append(c)
            time.sleep(0.8)
        except Exception:
            continue

    if not candidates:
        return ProductResult(sku_code=sku, status="未找到")

    best, best_html = choose_best_candidate(candidates, sku)
    ranked = sorted(candidates, key=lambda x: x.score, reverse=True)[:10]

    if not best:
        return ProductResult(sku_code=sku, status="未找到", candidates=[asdict(c) for c in ranked])

    try:
        parsed = parse_product_page(best.url, sku, html=best_html)
        parsed = merge_missing_fields_from_candidates(parsed, ranked, exclude_url=best.url, sku=sku)
        if best.score >= MIN_CONFIDENT_SCORE and best.matched_sku:
            status = "已找到"
        else:
            status = "待人工確認"

        return ProductResult(
            sku_code=sku,
            product_name=parsed.get("name"),
            product_image=parsed.get("image"),
            benefits=parsed.get("benefits"),
            ingredients=parsed.get("ingredients"),
            direction=parsed.get("direction"),
            country=parsed.get("country"),
            product_url=best.url,
            source_site=best.source_site,
            status=status,
            candidates=[asdict(c) for c in ranked],
        )
    except Exception:
        return ProductResult(
            sku_code=sku,
            product_url=best.url,
            source_site=best.source_site,
            status="待人工確認",
            candidates=[asdict(c) for c in ranked],
        )


def batch_lookup(skus: List[str], search_provider: SearchProvider) -> List[ProductResult]:
    results = []
    for sku in skus:
        sku = clean_text(sku)
        if not sku:
            continue
        results.append(lookup_sku(sku, search_provider))
        time.sleep(1.2)
    return results


if __name__ == "__main__":
    api_key = os.getenv("SERPAPI_KEY", "").strip()
    if not api_key:
        raise SystemExit("Missing SERPAPI_KEY")

    provider = SerpApiSearchProvider(api_key)

    sample_skus = ["4715243345844", "4973655561218", "664533288221"]

    results = batch_lookup(sample_skus, provider)
    for row in results:
        print(json.dumps(asdict(row), ensure_ascii=False, indent=2))
