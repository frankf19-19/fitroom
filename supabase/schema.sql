-- 試穿吧 TryOn — Supabase 資料庫設定
-- 在 Supabase 專案 → SQL Editor 貼上整段執行一次即可。

-- 會員檔與點數
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  credits integer not null default 0,
  created_at timestamptz not null default now()
);

-- 合成紀錄（cost = 0 代表用當日免費額度）
create table if not exists public.generations (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  items text[] not null default '{}',
  cost integer not null default 0,
  image_url text,
  created_at timestamptz not null default now()
);
create index if not exists generations_user_day on public.generations (user_id, created_at desc);

-- 衣櫃（使用者自己存的衣服圖）
create table if not exists public.garments (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('top','bottom','dress','shoes','hat','accessory','hair')),
  name text,
  image_url text not null,
  created_at timestamptz not null default now()
);
create index if not exists garments_user on public.garments (user_id, created_at desc);

-- 訂單
create table if not exists public.orders (
  id bigint generated always as identity primary key,
  trade_no text unique not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  pack text not null,
  credits integer not null,
  amount integer not null,
  status text not null default 'pending',
  ecpay_trade_no text,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

-- 新用戶自動建立 profile
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 加減點數（負數即扣點；餘額不足回傳 false）
create or replace function public.add_credits(p_user uuid, p_amount integer) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_new integer;
begin
  update public.profiles set credits = credits + p_amount where id = p_user and credits + p_amount >= 0
    returning credits into v_new;
  return v_new is not null;
end $$;
revoke all on function public.add_credits(uuid, integer) from public, anon, authenticated;

-- RLS：使用者只能看自己的資料；寫入由 Worker（service key）負責
alter table public.profiles enable row level security;
alter table public.generations enable row level security;
alter table public.garments enable row level security;
alter table public.orders enable row level security;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for select using (auth.uid() = id);

drop policy if exists "own generations" on public.generations;
create policy "own generations" on public.generations for select using (auth.uid() = user_id);
drop policy if exists "delete own generations" on public.generations;
create policy "delete own generations" on public.generations for delete using (auth.uid() = user_id);

drop policy if exists "own garments" on public.garments;
create policy "own garments" on public.garments for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own orders" on public.orders;
create policy "own orders" on public.orders for select using (auth.uid() = user_id);

-- Storage buckets：results（合成結果，Worker 寫）、wardrobe（衣櫃，使用者自己寫）
insert into storage.buckets (id, name, public) values ('results', 'results', true) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('wardrobe', 'wardrobe', true) on conflict (id) do nothing;

drop policy if exists "wardrobe owner write" on storage.objects;
create policy "wardrobe owner write" on storage.objects for insert to authenticated
  with check (bucket_id = 'wardrobe' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "wardrobe owner delete" on storage.objects;
create policy "wardrobe owner delete" on storage.objects for delete to authenticated
  using (bucket_id = 'wardrobe' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "public read images" on storage.objects;
create policy "public read images" on storage.objects for select using (bucket_id in ('results','wardrobe'));

-- v1.3：合成狀態與錯誤記錄（失敗不計入免費額度）
alter table public.generations add column if not exists status text not null default 'ok';
alter table public.generations add column if not exists error text;
alter table public.generations add column if not exists variants integer not null default 1;

-- v2.2：收藏
alter table public.generations add column if not exists favorite boolean not null default false;
drop policy if exists "update own generations" on public.generations;
create policy "update own generations" on public.generations for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- v2.3：使用行為事件、錯誤回報、偏好設定
create table if not exists public.events (
  id bigint generated always as identity primary key,
  user_id uuid,
  anon_id text,
  name text not null,
  props jsonb,
  platform text,
  created_at timestamptz not null default now()
);
create index if not exists events_name_day on public.events (name, created_at desc);
alter table public.events enable row level security;  -- 只有 Worker（service key）寫，不開放前端

create table if not exists public.client_errors (
  id bigint generated always as identity primary key,
  user_id uuid,
  message text,
  stack text,
  url text,
  platform text,
  app_version text,
  created_at timestamptz not null default now()
);
alter table public.client_errors enable row level security;

alter table public.profiles add column if not exists prefs jsonb not null default '{}'::jsonb;
drop policy if exists "update own profile prefs" on public.profiles;
create policy "update own profile prefs" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

-- ============ v1.5（2026-10-28 安全修正，整段執行一次）============
-- 1. 使用者只能改自己的 prefs，不能改 credits；紀錄只能改 favorite / deleted，不能刪除或改 cost
alter table public.generations add column if not exists free_used integer not null default 0;
alter table public.generations add column if not exists deleted boolean not null default false;
revoke update on public.profiles from authenticated, anon;
grant update (prefs) on public.profiles to authenticated;
revoke update, delete on public.generations from authenticated, anon;
grant update (favorite, deleted) on public.generations to authenticated;
drop policy if exists "delete own generations" on public.generations;
-- 2. 訂單不隨帳號刪除（對帳用）
alter table public.orders add column if not exists user_email text;
alter table public.orders alter column user_id drop not null;
alter table public.orders drop constraint if exists orders_user_id_fkey;
alter table public.orders add constraint orders_user_id_fkey foreign key (user_id) references auth.users(id) on delete set null;
-- 3. 管理後台聚合（不受 PostgREST 1000 列上限影響）
create or replace function public.admin_stats(p_day_start timestamptz) returns json
language sql security definer set search_path = public as $$
  select json_build_object(
    'users', (select count(*) from profiles),
    'gen_total', (select count(*) from generations where status = 'ok'),
    'gen_today', (select count(*) from generations where status = 'ok' and created_at >= p_day_start),
    'gen_week', (select count(*) from generations where status = 'ok' and created_at >= now() - interval '7 days'),
    'fail_week', (select count(*) from generations where status = 'failed' and created_at >= now() - interval '7 days'),
    'revenue', (select coalesce(sum(amount),0) from orders where status = 'paid'),
    'revenue_week', (select coalesce(sum(amount),0) from orders where status = 'paid' and paid_at >= now() - interval '7 days'),
    'orders_paid', (select count(*) from orders where status = 'paid'),
    'credits_outstanding', (select coalesce(sum(credits),0) from profiles),
    'by_type', (select coalesce(json_object_agg(t, n), '{}'::json) from (select unnest(items) as t, count(*) as n from generations where status='ok' and created_at >= now() - interval '7 days' group by 1) x),
    'funnel', (select coalesce(json_object_agg(name, n), '{}'::json) from (select name, count(distinct coalesce(user_id::text, anon_id)) as n from events where created_at >= now() - interval '7 days' group by 1) f),
    'failures', (select coalesce(json_agg(json_build_object('created_at', created_at, 'items', items, 'error', error) order by created_at desc), '[]'::json) from (select * from generations where status='failed' order by created_at desc limit 20) g),
    'recent_users', (select coalesce(json_agg(json_build_object('email', email, 'credits', credits, 'created_at', created_at) order by created_at desc), '[]'::json) from (select * from profiles order by created_at desc limit 20) u),
    'client_errors', (select coalesce(json_agg(json_build_object('created_at', created_at, 'message', message, 'url', url, 'platform', platform, 'app_version', app_version) order by created_at desc), '[]'::json) from (select * from client_errors order by created_at desc limit 20) c)
  );
$$;
revoke all on function public.admin_stats(timestamptz) from public, anon, authenticated;

-- v1.6：多角度（側面／背面）圖片網址
alter table public.generations add column if not exists views jsonb;
