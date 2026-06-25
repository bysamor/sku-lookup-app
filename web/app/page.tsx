"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

type JobSummary = {
  id: string;
  job_name: string | null;
  total_skus: number;
  processed_skus: number;
  status: string;
  created_at: string;
};

const STATUS_LABEL: Record<string, string> = {
  pending: "待處理",
  running: "查詢中",
  done: "完成",
  failed: "失敗",
};

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-gray-100 text-gray-600",
  running: "bg-blue-100 text-blue-700",
  done: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_BADGE[status] || "bg-gray-100 text-gray-600"}`}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

export default function HomePage() {
  const router = useRouter();
  const [mode, setMode] = useState<"single" | "batch">("single");
  const [jobName, setJobName] = useState("");
  const [singleSku, setSingleSku] = useState("");
  const [batchText, setBatchText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<JobSummary[] | null>(null);

  useEffect(() => {
    fetch("/api/lookup-jobs", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setHistory(d.jobs || []))
      .catch(() => setHistory([]));
  }, []);

  async function submit(skus: string[]) {
    setError(null);
    if (!skus.length) {
      setError("請輸入至少一個 SKU");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/lookup-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skus, jobName: jobName || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "建立查詢失敗");
      router.push(`/jobs/${data.jobId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "發生未知錯誤");
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit() {
    if (mode === "single") {
      submit([singleSku.trim()].filter(Boolean));
    } else {
      const skus = batchText
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
      submit(skus);
    }
  }

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">SKU 全網查詢工具</h1>
        <p className="mt-1 text-sm text-gray-500">
          輸入客戶提供的 SKU 編號，系統會在全網搜尋並擷取產品資料（繁體中文輸出）。
        </p>
      </div>

      <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <label className="mb-1.5 block text-xs font-medium text-gray-500">查詢任務名稱（選填）</label>
        <input
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
          value={jobName}
          onChange={(e) => setJobName(e.target.value)}
          placeholder="例如：客戶A 6月新品清單"
        />

        <div className="mt-5 flex gap-1 rounded-lg bg-gray-100 p-1 text-sm font-medium">
          <button
            className={`flex-1 rounded-md py-1.5 transition-colors ${mode === "single" ? "bg-white shadow-sm" : "text-gray-500"}`}
            onClick={() => setMode("single")}
          >
            單個 SKU
          </button>
          <button
            className={`flex-1 rounded-md py-1.5 transition-colors ${mode === "batch" ? "bg-white shadow-sm" : "text-gray-500"}`}
            onClick={() => setMode("batch")}
          >
            批量 SKU
          </button>
        </div>

        <div className="mt-4">
          {mode === "single" ? (
            <input
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
              value={singleSku}
              onChange={(e) => setSingleSku(e.target.value)}
              placeholder="輸入單個 SKU，例如 4715243345844"
            />
          ) : (
            <textarea
              className="h-40 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
              value={batchText}
              onChange={(e) => setBatchText(e.target.value)}
              placeholder={"每行一個 SKU，或以逗號分隔\n例如：\n4715243345844\n4973655561218\n664533288221"}
            />
          )}
        </div>

        <button
          className="mt-4 w-full rounded-lg bg-gray-900 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          disabled={loading}
          onClick={handleSubmit}
        >
          {loading ? "建立查詢中…" : mode === "single" ? "開始查詢" : "批量開始查詢"}
        </button>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-base font-semibold">歷史查詢記錄</h2>

        {history === null && (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-10 rounded-lg bg-gray-100" />
            ))}
          </div>
        )}

        {history?.length === 0 && <p className="text-sm text-gray-400">還沒有任何查詢記錄。</p>}

        {history && history.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                  <th className="py-2 font-medium">任務名稱</th>
                  <th className="py-2 font-medium">建立時間</th>
                  <th className="py-2 font-medium">進度</th>
                  <th className="py-2 font-medium">狀態</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {history.map((j) => (
                  <tr key={j.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                    <td className="py-2.5">{j.job_name || "—"}</td>
                    <td className="py-2.5 text-gray-500">{new Date(j.created_at).toLocaleString("zh-HK")}</td>
                    <td className="py-2.5 text-gray-500">
                      {j.processed_skus} / {j.total_skus}
                    </td>
                    <td className="py-2.5">
                      <StatusBadge status={j.status} />
                    </td>
                    <td className="py-2.5 text-right">
                      <a href={`/jobs/${j.id}`} className="font-medium text-gray-900 hover:underline">
                        查看結果 →
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
