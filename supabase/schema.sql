-- SKU Lookup App — Supabase schema (MVP)
-- Run this in the Supabase SQL editor, or via `supabase db push`.

create extension if not exists pgcrypto;

create table if not exists lookup_jobs (
  id uuid primary key default gen_random_uuid(),
  job_name text,
  total_skus int not null default 0,
  processed_skus int not null default 0,
  status text not null default 'pending', -- pending | running | done | failed
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists lookup_items (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references lookup_jobs(id) on delete cascade,
  sku_code text not null,

  -- 全部輸出欄位皆為繁體中文 (zh-HK)
  product_name text,
  product_image text,
  benefits text,        -- 功效/好處
  ingredients text,     -- 成分
  direction text,       -- 使用方法
  country text,         -- 原產地
  product_url text,     -- 產品網址
  source_site text,     -- 來源網站

  status text not null default 'pending', -- pending | found | needs_review | not_found | failed
  best_candidate_id uuid, -- 手動或自動選定的最佳候選 (references lookup_candidates.id, set after insert)
  reviewed boolean not null default false, -- 使用者是否已人工確認/編輯過

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists lookup_candidates (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references lookup_items(id) on delete cascade,
  title text,
  url text,
  snippet text,
  score numeric default 0,
  matched_sku boolean default false,
  source_site text,
  is_selected boolean not null default false, -- 目前是否為最佳結果
  created_at timestamptz not null default now()
);

alter table lookup_items
  add constraint fk_best_candidate
  foreign key (best_candidate_id) references lookup_candidates(id) on delete set null;

create index if not exists idx_lookup_items_job_id on lookup_items(job_id);
create index if not exists idx_lookup_items_sku_code on lookup_items(sku_code);
create index if not exists idx_lookup_candidates_item_id on lookup_candidates(item_id);

-- keep updated_at fresh automatically
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_lookup_jobs_updated_at on lookup_jobs;
create trigger trg_lookup_jobs_updated_at
  before update on lookup_jobs
  for each row execute function set_updated_at();

drop trigger if exists trg_lookup_items_updated_at on lookup_items;
create trigger trg_lookup_items_updated_at
  before update on lookup_items
  for each row execute function set_updated_at();

-- RLS: MVP 假設 admin app 只用 service role key 存取，前端不直連 Supabase。
alter table lookup_jobs enable row level security;
alter table lookup_items enable row level security;
alter table lookup_candidates enable row level security;
-- 不建立任何 policy => 只有 service_role key 可存取（service role 會 bypass RLS）。
