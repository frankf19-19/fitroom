-- 刪除帳號時一次清掉該使用者在 Storage 的所有圖片（results、wardrobe 兩個 bucket）。
-- 在 Supabase SQL Editor 執行一次即可。Worker 的 /api/delete-account 會優先呼叫這個函式；
-- 沒有建立時 Worker 會退回「逐層列出再刪」的方式（較慢、呼叫次數有限）。
--
-- 只給 service_role 用（Worker 用 service key 呼叫），一般使用者不能執行。
-- 注意：直接刪 storage.objects 的列後，公開網址立即失效（Storage API 以這張表為準），
-- 但底層 S3 檔案可能留到 Supabase 的孤兒清理才真正移除；若在意儲存空間，仍可偶爾用 Dashboard 清理。

create or replace function public.delete_user_objects(p_user uuid)
returns integer
language plpgsql
security definer
set search_path = storage, public
as $$
declare
  n integer;
begin
  delete from storage.objects
  where bucket_id in ('results', 'wardrobe')
    and name like p_user::text || '/%';
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.delete_user_objects(uuid) from public, anon, authenticated;
grant execute on function public.delete_user_objects(uuid) to service_role;
