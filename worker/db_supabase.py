"""
Supabase 存取層（worker 端，使用 service role key，bypass RLS）。
"""

from __future__ import annotations

import os
from typing import List, Dict, Any, Optional

from supabase import create_client, Client

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()

if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


def get_job(job_id: str) -> Optional[Dict[str, Any]]:
    res = supabase.table("lookup_jobs").select("*").eq("id", job_id).execute()
    return res.data[0] if res.data else None


def get_pending_items(job_id: str) -> List[Dict[str, Any]]:
    res = (
        supabase.table("lookup_items")
        .select("*")
        .eq("job_id", job_id)
        .eq("status", "pending")
        .order("created_at")
        .execute()
    )
    return res.data


def update_lookup_item(item_id: str, values: Dict[str, Any]) -> Dict[str, Any]:
    res = supabase.table("lookup_items").update(values).eq("id", item_id).execute()
    return res.data[0] if res.data else {}


def insert_candidates(item_id: str, candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rows = []
    for c in candidates:
        rows.append(
            {
                "item_id": item_id,
                "title": c.get("title"),
                "url": c.get("url"),
                "snippet": c.get("snippet"),
                "score": c.get("score", 0),
                "matched_sku": c.get("matched_sku", False),
                "source_site": c.get("source_site"),
            }
        )
    if not rows:
        return []
    res = supabase.table("lookup_candidates").insert(rows).execute()
    return res.data


def mark_candidate_selected(item_id: str, candidate_id: str) -> None:
    supabase.table("lookup_candidates").update({"is_selected": False}).eq("item_id", item_id).execute()
    supabase.table("lookup_candidates").update({"is_selected": True}).eq("id", candidate_id).execute()
    supabase.table("lookup_items").update({"best_candidate_id": candidate_id}).eq("id", item_id).execute()


def mark_job_progress(job_id: str, processed_skus: int, status: Optional[str] = None) -> None:
    payload: Dict[str, Any] = {"processed_skus": processed_skus}
    if status:
        payload["status"] = status
    supabase.table("lookup_jobs").update(payload).eq("id", job_id).execute()
