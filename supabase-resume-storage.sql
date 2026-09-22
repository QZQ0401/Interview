-- ============================================================
-- 秋招 Tracker V3.3 - 简历私有存储
-- 在 Supabase Dashboard -> SQL Editor 中执行一次即可。
-- ============================================================

-- 1. 创建私有 resumes bucket。
--    10 MB 是单个原始简历/预览图片对象的上限。
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'resumes',
  'resumes',
  false,
  10485760,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg'
  ]::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- 2. 每个用户只能访问以自己 auth.uid() 命名的一级目录。
drop policy if exists "Resume owners can read own files" on storage.objects;
drop policy if exists "Resume owners can upload own files" on storage.objects;
drop policy if exists "Resume owners can update own files" on storage.objects;
drop policy if exists "Resume owners can delete own files" on storage.objects;

create policy "Resume owners can read own files"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'resumes'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

create policy "Resume owners can upload own files"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'resumes'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

create policy "Resume owners can update own files"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'resumes'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
)
with check (
  bucket_id = 'resumes'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

create policy "Resume owners can delete own files"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'resumes'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);
