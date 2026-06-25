"""
最小 worker HTTP 服務：Next.js 建立 job 後呼叫這裡來觸發實際的搜尋作業。
部署到任何能跑 Python 的地方（Render / Railway / Fly.io），Vercel 上的 Next.js 用
WORKER_BASE_URL 呼叫它。
"""

from __future__ import annotations

from fastapi import FastAPI, BackgroundTasks, HTTPException
from pydantic import BaseModel

from worker_run_job import run_lookup_job

app = FastAPI(title="SKU Lookup Worker")


class RunJobPayload(BaseModel):
    job_id: str


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/run-job")
def run_job(payload: RunJobPayload, background_tasks: BackgroundTasks):
    try:
        background_tasks.add_task(run_lookup_job, payload.job_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"status": "accepted", "job_id": payload.job_id}
