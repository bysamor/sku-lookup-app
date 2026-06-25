# SKU Lookup App（MVP）

根據客戶提供的 SKU 編號，用搜尋引擎在全網查找產品資料，擷取關鍵欄位並翻譯為繁體中文（zh-HK）。
不針對單一網站，而是「以 SKU 搜尋為中心」找候選頁面再比對擷取。

## 架構

```
sku-lookup-app/
├── web/                # Next.js App Router（前端 + Admin + API routes）
│   ├── app/
│   │   ├── page.tsx                       # 首頁：單個 / 批量 SKU 輸入
│   │   ├── jobs/[jobId]/page.tsx           # 結果列表 + 候選來源 + 編輯 + 匯出
│   │   ├── lib/supabaseServer.ts
│   │   └── api/
│   │       ├── lookup-jobs/route.ts                          # 建立 job（呼叫 worker）
│   │       ├── lookup-jobs/[jobId]/route.ts                  # 取得 job + items + candidates
│   │       ├── lookup-jobs/[jobId]/export/route.ts           # 匯出 CSV（繁中欄位）
│   │       ├── lookup-items/[itemId]/route.ts                # PATCH 編輯繁中欄位
│   │       └── lookup-items/[itemId]/select-candidate/route.ts # 手動選最佳結果
│   ├── package.json
│   └── .env.example
├── worker/             # Python lookup worker（搜尋 + 擷取 + 翻譯）
│   ├── sku_lookup_search.py   # 核心邏輯：search -> fetch -> score -> parse -> translate
│   ├── db_supabase.py         # Supabase 讀寫（service role）
│   ├── worker_run_job.py      # 跑完整個 job：逐 SKU 處理、寫回 DB、更新進度
│   ├── app_fastapi.py         # 對外 HTTP 服務，給 Next.js 觸發 /run-job
│   ├── requirements.txt
│   └── .env.example
└── supabase/
    └── schema.sql      # lookup_jobs / lookup_items / lookup_candidates
```

## 資料流程

1. 使用者在 Next.js 輸入單個或批量 SKU → `POST /api/lookup-jobs`
2. Next.js 寫入 `lookup_jobs` + `lookup_items`（狀態 `pending`），呼叫 Python worker 的 `POST /run-job`
3. Worker 對每個 SKU：
   - 用 SKU 做 web search（SerpAPI，可替換成 Bing/Google CSE）
   - 抓取候選頁 HTML，計分排序：**SKU 完全匹配 > 商品頁網址結構 > 品牌/成分/功效關鍵字命中**；社群/電商聚合站（Amazon、FB、IG）降分
   - 對分數最高的候選頁擷取欄位（優先讀 JSON-LD `Product`，缺的欄位用關鍵字區塊比對：Benefits/Ingredients/Directions/Country）
   - 所有文字欄位呼叫翻譯 API 轉繁體中文（zh-HK）；未設定 `TRANSLATE_API_KEY` 時原文照搬，方便本地開發
   - 寫回 `lookup_items`（最佳結果）與 `lookup_candidates`（候選列表，含分數）
4. 前端輪詢 job 進度，顯示結果列表；使用者可在「候選來源」中手動切換最佳結果，或直接編輯繁中欄位後儲存
5. 匯出 CSV（含 BOM，Excel 開啟不會有亂碼）

## 欄位對照

| 內部欄位 (DB) | 顯示名稱 |
|---|---|
| sku_code | SKU 編號 |
| product_name | 產品名稱 |
| product_image | 產品圖片 |
| benefits | 功效/好處 |
| ingredients | 成分 |
| direction | 使用方法 |
| country | 原產地 |
| product_url | 產品網址 |
| source_site | 來源網站 |
| status | 狀態（已找到 / 待人工確認 / 未找到） |

缺失欄位留空；完全找不到資料時狀態為「未找到」。

## 安裝與啟動

### 1. Supabase

在 Supabase 專案的 SQL editor 執行 `supabase/schema.sql`。記下 `Project URL` 與 `service_role` key。

### 2. Worker（Python）

```bash
cd worker
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # 填入 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SERPAPI_KEY

# 本地起 HTTP 服務（給 Next.js 呼叫）
uvicorn app_fastapi:app --reload --port 8000

# 或直接命令列跑單個 job（除錯用）
python worker_run_job.py <job_id>
```

部署：放到 Render / Railway / Fly.io 等任何能跑 Python 長駐服務的平台（Vercel 本身不適合跑長時間的 scraping worker）。

### 3. Web（Next.js，部署到 Vercel）

```bash
cd web
npm install
cp .env.example .env.local   # 填入 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / WORKER_BASE_URL
npm run dev
```

開 http://localhost:3000

## Sample 測試流程

1. 啟動 worker：`uvicorn app_fastapi:app --reload --port 8000`
2. 啟動 web：`npm run dev`（`WORKER_BASE_URL=http://localhost:8000`）
3. 在首頁「單個 SKU 查詢」輸入一個真實商品的 SKU/EAN/UPC（例如 `4715243345844`），點「開始查詢」
4. 自動導向 `/jobs/<jobId>`，每 4 秒輪詢一次進度
5. 完成後該列顯示「已找到」或「待人工確認」，點「查看 / 編輯」：
   - 右側「候選來源」可看到所有候選頁與分數，點「設為最佳結果」可手動覆寫
   - 左側可直接編輯繁體中文欄位後按「儲存」
6. 測試批量：在「批量 SKU 查詢」貼上多行 SKU，確認每個 SKU 各自成一列、互不影響
7. 點頂部「匯出 CSV」，確認下載的 CSV 用 Excel 開啟繁體中文無亂碼

## 已知限制（MVP 範圍內，刻意不做）

- 搜尋引擎目前用 SerpAPI；要換 Bing/Google CSE 只需新增一個 `SearchProvider` 子類別
- 沒有帳號權限系統（單一團隊內部工具，前端只透過 server route 用 service role key 存取 Supabase）
- 沒有自動重試/排程，失敗的 SKU 需在前端手動編輯或重新建立 job
- 圖片比對只取第一張（og:image / JSON-LD image），不做多圖比對
