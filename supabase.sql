-- =========================================================
-- 秋招 Tracker V2 - Supabase 数据表与 RLS
-- 在 Supabase Dashboard -> SQL Editor 中执行一次。
-- =========================================================

-- 每个登录用户只保存一行 JSON 数据，便于静态网页整体同步。
create table if not exists public.user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 开启行级安全策略。
alter table public.user_data enable row level security;

-- 支持重复执行此 SQL。
drop policy if exists "Users can read own tracker data" on public.user_data;
drop policy if exists "Users can insert own tracker data" on public.user_data;
drop policy if exists "Users can update own tracker data" on public.user_data;
drop policy if exists "Users can delete own tracker data" on public.user_data;

-- 登录用户只能读取自己的数据。
create policy "Users can read own tracker data"
on public.user_data
for select
to authenticated
using (auth.uid() = user_id);

-- 登录用户只能插入自己的数据。
create policy "Users can insert own tracker data"
on public.user_data
for insert
to authenticated
with check (auth.uid() = user_id);

-- 登录用户只能更新自己的数据。
create policy "Users can update own tracker data"
on public.user_data
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- 登录用户只能删除自己的数据。
create policy "Users can delete own tracker data"
on public.user_data
for delete
to authenticated
using (auth.uid() = user_id);

-- 可选索引。
create index if not exists user_data_updated_at_idx
on public.user_data(updated_at desc);
