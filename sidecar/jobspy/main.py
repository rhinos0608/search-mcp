import os
import asyncio
from typing import List, Optional, Union
from fastapi import FastAPI, HTTPException, Header, Depends, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, validator
from jobspy import scrape_jobs
import pandas as pd
import time
from collections import defaultdict

app = FastAPI(title="JobSpy Bridge Sidecar")

# ── Configuration ────────────────────────────────────────────────────────────

API_KEY = os.getenv("JOBSPY_API_KEY", "default-key-change-me")
SCRAPE_TIMEOUT = int(os.getenv("JOBSPY_TIMEOUT", "55"))
RATE_LIMIT_PER_MIN = 20

# ── In-memory Rate Limiter ───────────────────────────────────────────────────

class RateLimiter:
    def __init__(self, limit: int):
        self.limit = limit
        self.requests = defaultdict(list)

    def is_allowed(self, key: str) -> bool:
        now = time.time()
        # Cleanup old requests
        self.requests[key] = [t for t in self.requests[key] if now - t < 60]
        if len(self.requests[key]) >= self.limit:
            return False
        self.requests[key].append(now)
        return True

limiter = RateLimiter(RATE_LIMIT_PER_MIN)

# ── Dependency: Auth ─────────────────────────────────────────────────────────

async def verify_api_key(x_api_key: Optional[str] = Header(None)):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={ "error": "AUTH_FAILED", "message": "Invalid or missing API Key", "retryable": False }
        )

# ── Schema ───────────────────────────────────────────────────────────────────

class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1)
    location: Optional[str] = None
    radius: Optional[int] = Field(25, ge=0)
    is_remote: bool = False
    job_type: Optional[str] = None
    results_wanted: int = Field(20, gt=0, le=100)
    sites: List[str] = ["linkedin", "indeed", "glassdoor", "zip_recruiter"]
    hours_old: Optional[int] = None
    country: Optional[str] = "usa"

    @validator('query')
    def sanitize_query(cls, v):
        return v.strip()

# ── Endpoints ────────────────────────────────────────────────────────────────

@app.post("/search", dependencies=[Depends(verify_api_key)])
async def search(request_data: SearchRequest, req: Request):
    # Rate Limiting
    client_ip = req.client.host
    if not limiter.is_allowed(client_ip):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={ "error": "RATE_LIMIT", "message": "Rate limit exceeded (20 req/min)", "retryable": True }
        )

    try:
        loop = asyncio.get_event_loop()
        
        # Scrape jobs in a thread pool since it's a blocking operation
        # Note: radius mapping: jobspy uses 'distance'
        jobs_df = await asyncio.wait_for(
            loop.run_in_executor(None, lambda: scrape_jobs(
                site_name=request_data.sites,
                search_term=request_data.query,
                location=request_data.location,
                distance=request_data.radius,
                is_remote=request_data.is_remote,
                job_type=request_data.job_type,
                results_wanted=request_data.results_wanted,
                country_indeed=request_data.country,
                hours_old=request_data.hours_old,
                description_format="markdown"
            )),
            timeout=SCRAPE_TIMEOUT
        )
        
        # Handle empty results
        if jobs_df is None or jobs_df.empty:
            return {"jobs": []}

        # Convert Pandas DataFrame to list of dicts
        # Replace NaN with None for JSON compatibility
        records = jobs_df.where(pd.notnull(jobs_df), None).to_dict('records')
        return {"jobs": records}
        
    except asyncio.TimeoutError:
        return JSONResponse(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            content={ "error": "TIMEOUT", "message": "JobSpy scrape operation timed out", "retryable": True }
        )
    except Exception as e:
        error_msg = str(e)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={ "error": "INTERNAL_ERROR", "message": error_msg, "retryable": True }
        )

@app.get("/health")
async def health():
    return {"status": "ok", "version": "1.0.0"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
