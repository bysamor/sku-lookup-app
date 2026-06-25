"""
執行一個 lookup_job：取出所有 pending 的 lookup_items，逐一做 SKU 搜尋與擷取，
寫回 lookup_items + lookup_candidates，並更新 job 進度。
"""

from __future__ import annotations

import os
import time
from dataclasses import asdict

from db_supabase import (
    get_job,
    get_pending_items,
    update_lookup_item,
    insert_candidates,
    mark_candidate_selected,
    mark_job_progress,
)
from sku_lookup_search import SerpApiSearchProvider, lookup_sku


def run_lookup_job(job_id: str) -> None:
    job = get_job(job_id)
    if not job:
        raise ValueError(f"job not found: {job_id}")

    api_key = os.getenv("SERPAPI_KEY", "").strip()
    if not api_key:
        mark_job_progress(job_id, job.get("processed_skus", 0), status="failed")
        raise RuntimeError("Missing SERPAPI_KEY")

    provider = SerpApiSearchProvider(api_key)
    mark_job_progress(job_id, job.get("processed_skus", 0), status="running")

    items = get_pending_items(job_id)
    processed = job.get("processed_skus", 0)

    for item in items:
        sku = item["sku_code"]
        try:
            result = lookup_sku(sku, provider)

            status_map = {"已找到": "found", "待人工確認": "needs_review", "未找到": "not_found"}

            updated = update_lookup_item(
                item["id"],
                {
                    "product_name": result.product_name,
                    "product_image": result.product_image,
                    "benefits": result.benefits,
                    "ingredients": result.ingredients,
                    "direction": result.direction,
                    "country": result.country,
                    "product_url": result.product_url,
                    "source_site": result.source_site,
                    "status": status_map.get(result.status, "needs_review"),
                },
            )

            if result.candidates:
                inserted = insert_candidates(item["id"], result.candidates)
                # 自動選定分數最高者為最佳候選（使用者之後可在前端手動覆寫）
                if inserted:
                    best = max(inserted, key=lambda c: c.get("score") or 0)
                    mark_candidate_selected(item["id"], best["id"])

        except Exception as exc:  # noqa: BLE001 - MVP: 記錄失敗並繼續下一個 SKU
            update_lookup_item(item["id"], {"status": "failed"})
            print(f"[worker] failed sku={sku}: {exc}")

        processed += 1
        mark_job_progress(job_id, processed)
        time.sleep(1.0)

    mark_job_progress(job_id, processed, status="done")


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        raise SystemExit("usage: python worker_run_job.py <job_id>")
    run_lookup_job(sys.argv[1])
