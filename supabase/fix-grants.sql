-- 修正：Worker（service_role）要能呼叫這兩個函式
grant execute on function public.add_credits(uuid, integer) to service_role;
grant execute on function public.admin_stats(timestamptz) to service_role;
-- 管理者測試點數
update public.profiles set credits = credits + 300 where lower(email) = 'frankccc199@gmail.com';
select email, credits from public.profiles;
