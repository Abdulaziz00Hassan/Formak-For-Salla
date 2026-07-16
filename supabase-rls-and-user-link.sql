-- ════════════════════════════════════════════════════════════════════
-- Formak — تفعيل RLS + ربط auth.users ↔ merchants
-- ════════════════════════════════════════════════════════════════════
-- ⚠️ شغّل هذا الملف بالكامل في Supabase SQL Editor قبل اختبار /dashboard/mappings
-- ⚠️ تأكد أن الجداول الثلاث موجودة (نفّذ supabase-schema.sql أولاً إن لم تكن)
-- ════════════════════════════════════════════════════════════════════

-- ── 0) إضافة عمود الربط بين auth.users و merchants ─────────────────
alter table merchants
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- قيد فريد: مستخدم واحد → تاجر واحد فقط
create unique index if not exists merchants_user_id_unique
  on merchants(user_id) where user_id is not null;

-- فهرس مساعد لسرعة البحث العكسي
create index if not exists merchants_user_id_idx
  on merchants(user_id);

-- ── 1) دالة SECURITY DEFINER تكشف merchant_id للمستخدم الحالي ──────
-- SECURITY DEFINER: تُنفَّذ بصلاحيات مالك الدالة (postgres) → تتجاوز RLS
-- على جدول merchants عند الاستعلام الفرعي. هذا ضروري وإلا فُقد العزل
-- في cascade (الدالة نفسها كانت ستُقيَّد بسياسة merchants).
--
-- ⚠️ النقطة الأمنية الحرجة: الدالة تُرجِع فقط merchant_id للمستخدم
-- الحالي (auth.uid()) ولا تستقبل أي معامل. لا يمكن استغلالها للتجسس
-- على تاجر آخر لأن الفلترة بـ auth.uid() مفروضة على مستوى الجلسة.

create or replace function public.current_merchant_id()
returns uuid
language sql
stable                          -- لا تغيّر النتيجة خلال المعاملة الواحدة
security definer                 -- تتجاوز RLS للقراءة من merchants
set search_path = ''             -- أمان: لا تسمح بمساحة بحث قابلة للتلاعب
as $$
  select id
  from public.merchants
  where user_id = auth.uid()
  limit 1;
$$;

-- الصلاحيات: authenticated فقط (anon لا يحتاجها)
grant execute on function public.current_merchant_id() to authenticated;

-- ── 2) تفعيل RLS على الجداول الثلاثة ───────────────────────────────
alter table merchants             enable row level security;
alter table product_designer_map  enable row level security;
alter table order_routing_log     enable row level security;

-- ── 3) سياسات merchants: المستخدم يرى صفه فقط ──────────────────────
create policy "merchants_select_own"
  on merchants
  for select
  to authenticated
  using (user_id = auth.uid());

-- ملاحظة: لا سياسات INSERT/UPDATE/DELETE على merchants لـauthenticated.
-- التاجر يُنشأ فقط عبر OAuth callback (server-side، service role).
-- هذا متعمَّد: لا نريد أن ينشئ مستخدم صف تاجر لنفسه.

-- ── 4) سياسات product_designer_map: CRUD كامل على صفوف تاجره فقط ───
create policy "product_designer_map_select_own"
  on product_designer_map
  for select
  to authenticated
  using (merchant_id = public.current_merchant_id());

create policy "product_designer_map_insert_own"
  on product_designer_map
  for insert
  to authenticated
  with check (merchant_id = public.current_merchant_id());

create policy "product_designer_map_update_own"
  on product_designer_map
  for update
  to authenticated
  using (merchant_id = public.current_merchant_id())
  with check (merchant_id = public.current_merchant_id());

create policy "product_designer_map_delete_own"
  on product_designer_map
  for delete
  to authenticated
  using (merchant_id = public.current_merchant_id());

-- ── 5) سياسات order_routing_log: قراءة فقط للمستخدمين ─────────────
-- الكتابة هنا من السيرفر فقط (webhook handler عبر service role).
create policy "order_routing_log_select_own"
  on order_routing_log
  for select
  to authenticated
  using (merchant_id = public.current_merchant_id());

-- لا سياسات INSERT/UPDATE/DELETE لـauthenticated على هذا الجدول.

-- ════════════════════════════════════════════════════════════════════
-- ✅ بعد التنفيذ، تحقّق سريع:
-- ════════════════════════════════════════════════════════════════════
-- استعلام يعيد السياسات المُنشأة (يجب أن ترى 6 سياسات):
--   select schemaname, tablename, policyname, cmd, roles
--   from pg_policies
--   where schemaname = 'public'
--   order by tablename, policyname;
