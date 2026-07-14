"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";

type Candidate = {
  id: string;
  title: string | null;
  url: string | null;
  snippet: string | null;
  score: number | null;
  matched_sku: boolean | null;
  source_site: string | null;
  is_selected: boolean | null;
};

type Item = {
  id: string;
  sku_code: string;
  product_name: string | null;
  product_image: string | null;
  benefits: string | null;
  ingredients: string | null;
  direction: string | null;
  country: string | null;
  product_url: string | null;
  source_site: string | null;
  status: string;
  reviewed: boolean;
  lookup_candidates: Candidate[];
};

type Job = {
  id: string;
  job_name: string | null;
  total_skus: number;
  processed_skus: number;
  status: string;
};

const STATUS_LABEL: Record<string, string> = {
  pending: "待處理",
  running: "查詢中",
  done: "完成",
  failed: "失敗",
  found: "已找到",
  needs_review: "待人工確認",
  not_found: "未找到",
};

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-gray-100 text-gray-600",
  running: "bg-blue-100 text-blue-700",
  done: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  found: "bg-green-100 text-green-700",
  needs_review: "bg-amber-100 text-amber-700",
  not_found: "bg-red-100 text-red-700",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_BADGE[status] || "bg-gray-100 text-gray-600"}`}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

export default function JobPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const [job, setJob] = useState<Job | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/lookup-jobs/${jobId}`, { cache: "no-store" });
    const data = await res.json();
    if (res.ok) {
      setJob(data.job);
      setItems(data.items || []);
    }
  }, [jobId]);

  useEffect(() => {
    load();
  }, [load]);

  // job 還在跑的時候輪詢進度
  useEffect(() => {
    if (!job || job.status === "done" || job.status === "failed") return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [job, load]);

  async function selectCandidate(itemId: string, candidateId: string) {
    const res = await fetch(`/api/lookup-items/${itemId}/select-candidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId }),
    });
    const data = await res.json();
    load();
    // worker 在背景重新抓取候選頁內容，5 秒後再自動刷新一次
    if (data?.reExtracting) {
      setTimeout(load, 5000);
      setTimeout(load, 12000);
    }
  }

  async function saveItem(itemId: string, values: Partial<Item>) {
    await fetch(`/api/lookup-items/${itemId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    load();
  }

  if (!job) {
    return (
      <main className="space-y-3">
        <div className="skeleton h-6 w-40 rounded bg-gray-200" />
        <div className="skeleton h-10 w-full rounded-lg bg-gray-100" />
        <div className="skeleton h-10 w-full rounded-lg bg-gray-100" />
      </main>
    );
  }

  const progressPct = job.total_skus ? Math.round((job.processed_skus / job.total_skus) * 100) : 0;

  return (
    <main className="space-y-5">
      <a href="/" className="text-sm text-gray-500 hover:text-gray-900">
        ← 回首頁
      </a>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{job.job_name || "SKU 查詢任務"}</h1>
          <div className="mt-2 flex items-center gap-2">
            <StatusBadge status={job.status} />
            <span className="text-sm text-gray-500">
              進度 {job.processed_skus} / {job.total_skus}
            </span>
          </div>
          {job.status === "running" && (
            <div className="mt-2 h-1.5 w-48 overflow-hidden rounded-full bg-gray-100">
              <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${progressPct}%` }} />
            </div>
          )}
        </div>
        <a
          href={`/api/lookup-jobs/${jobId}/export`}
          download={`sku-lookup-${jobId}.csv`}
          className="inline-flex items-center rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          匯出 CSV
        </a>
      </div>

      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
              <th className="px-4 py-3 font-medium">SKU 編號</th>
              <th className="px-4 py-3 font-medium">產品名稱</th>
              <th className="px-4 py-3 font-medium">產品圖片</th>
              <th className="px-4 py-3 font-medium">狀態</th>
              <th className="px-4 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                expanded={expandedId === item.id}
                onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
                onSelectCandidate={selectCandidate}
                onSave={saveItem}
              />
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function ItemRow({
  item,
  expanded,
  onToggle,
  onSelectCandidate,
  onSave,
}: {
  item: Item;
  expanded: boolean;
  onToggle: () => void;
  onSelectCandidate: (itemId: string, candidateId: string) => void;
  onSave: (itemId: string, values: Partial<Item>) => void;
}) {
  const [draft, setDraft] = useState<Partial<Item>>(item);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(item);
  }, [item]);

  const candidates = [...(item.lookup_candidates || [])].sort(
    (a, b) => (b.score || 0) - (a.score || 0)
  );
  const maxScore = Math.max(1, ...candidates.map((c) => c.score || 0));

  async function handleSave() {
    setSaving(true);
    await onSave(item.id, draft);
    setSaving(false);
  }

  return (
    <>
      <tr className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
        <td className="px-4 py-3 font-mono text-xs text-gray-700">{item.sku_code}</td>
        <td className="max-w-xs truncate px-4 py-3">{item.product_name || "—"}</td>
        <td className="px-4 py-3">
          {item.product_image ? (
            <img
              src={`/api/lookup-items/${item.id}/image`}
              alt=""
              className="h-10 w-10 rounded-md border border-gray-200 object-cover"
            />
          ) : (
            <span className="text-gray-400">—</span>
          )}
        </td>
        <td className="px-4 py-3">
          <StatusBadge status={item.status} />
        </td>
        <td className="px-4 py-3 text-right">
          <button
            className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium hover:bg-gray-100"
            onClick={onToggle}
          >
            {expanded ? "收起" : "查看 / 編輯"}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-gray-100">
          <td colSpan={5} className="bg-gray-50 px-4 py-5">
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div>
                <h4 className="mb-3 text-sm font-semibold text-gray-700">繁體中文欄位（可編輯）</h4>

                {item.product_image && (
                  <div className="mb-4">
                    <img
                      src={`/api/lookup-items/${item.id}/image`}
                      alt=""
                      className="mb-2 h-40 w-40 rounded-lg border border-gray-200 object-cover"
                    />
                    <a
                      href={`/api/lookup-items/${item.id}/image?download=1`}
                      className="inline-flex items-center rounded-md border border-gray-300 px-3 py-1 text-xs font-medium hover:bg-gray-100"
                    >
                      下載圖片
                    </a>
                  </div>
                )}

                <div className="space-y-3">
                  {(
                    [
                      ["product_name", "產品名稱"],
                      ["product_image", "產品圖片網址"],
                      ["benefits", "功效/好處"],
                      ["ingredients", "成分"],
                      ["direction", "使用方法"],
                      ["country", "原產地"],
                      ["product_url", "產品網址"],
                      ["source_site", "來源網站"],
                    ] as const
                  ).map(([field, fieldLabel]) => (
                    <div key={field}>
                      <label className="mb-1 block text-xs font-medium text-gray-500">{fieldLabel}</label>
                      <textarea
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
                        rows={field === "benefits" || field === "ingredients" || field === "direction" ? 3 : 1}
                        value={(draft[field] as string) || ""}
                        onChange={(e) => setDraft((d) => ({ ...d, [field]: e.target.value }))}
                      />
                    </div>
                  ))}

                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-500">狀態</label>
                    <select
                      className="rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
                      value={draft.status || item.status}
                      onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}
                    >
                      <option value="found">已找到</option>
                      <option value="needs_review">待人工確認</option>
                      <option value="not_found">未找到</option>
                    </select>
                  </div>

                  <button
                    className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                    disabled={saving}
                    onClick={handleSave}
                  >
                    {saving ? "儲存中…" : "儲存"}
                  </button>
                </div>
              </div>

              <div>
                <h4 className="mb-3 text-sm font-semibold text-gray-700">
                  候選來源（按可信度排序，點選設為最佳結果）
                </h4>
                {candidates.length === 0 && <p className="text-sm text-gray-400">沒有候選結果。</p>}
                <ul className="space-y-2">
                  {candidates.map((c) => (
                    <li
                      key={c.id}
                      className={`rounded-lg border p-3 ${c.is_selected ? "border-gray-900 bg-white shadow-sm" : "border-gray-200 bg-white"}`}
                    >
                      <div className="text-sm font-semibold text-gray-900">{c.title || c.url}</div>
                      <div className="mt-0.5 text-xs text-gray-500">{c.source_site}</div>
                      <a
                        href={c.url || "#"}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 block truncate text-xs text-blue-600 hover:underline"
                      >
                        {c.url}
                      </a>

                      <div className="mt-2 flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100">
                          <div
                            className={`h-full rounded-full ${c.matched_sku ? "bg-green-500" : "bg-gray-400"}`}
                            style={{ width: `${Math.max(2, ((c.score || 0) / maxScore) * 100)}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-500">
                          {c.score}
                          {c.matched_sku ? " ｜ SKU 匹配" : ""}
                        </span>
                      </div>

                      <div className="mt-2">
                        {!c.is_selected ? (
                          <button
                            className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium hover:bg-gray-100"
                            onClick={() => onSelectCandidate(item.id, c.id)}
                          >
                            設為最佳結果
                          </button>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-gray-900 px-2.5 py-0.5 text-xs font-medium text-white">
                            目前最佳結果
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
