-- ════════════════════════════════════════════════════════════════════
-- Formak — CHECK constraint لصيغة رقم واتساب المصمم (Defense-in-Depth)
-- ════════════════════════════════════════════════════════════════════
-- ⚠️ نفّذ هذا الملف في Supabase SQL Editor بعد supabase-rls-and-user-link.sql
-- ⚠️ يضيف حماية على مستوى قاعدة البيانات (DB-side) لمنع إدخال أرقام
--    غير صالحة حتى لو تم تجاوز Server Action validator.
--
-- المنطق: رقم واتساب سعودي للجوال = 9665xxxxxxxx (5 بعد 966 ثم 8 أرقام).
--    - 966 = مفتاح السعودية
--    - 5  = بادئة الجوال (الخطوط الأرضية تبدأ بـ 1 أو 2)
--    - 8 أرقام = الجزء الفردي من رقم الجوال
--
-- يجب أن يطابق هذا النمط تماماً الـ regex في app/lib/validators.ts:
--    WHATSAPP_INTL_REGEX = /^9665\d{8}$/
-- ════════════════════════════════════════════════════════════════════

-- 1) تنظيف: إسقاط القيد إن وُجد مسبقاً (لجعل السكربت idempotent)
alter table product_designer_map
  drop constraint if exists designer_whatsapp_format_check;

-- 2) إضافة القيد
alter table product_designer_map
  add constraint designer_whatsapp_format_check
  check (designer_whatsapp ~ '^9665\d{8}$');

-- 3) فحص سريع: القيد مفعّل؟
--    يجب أن يعرض PostgreSQL اسم القيد ووصفه:
select
  conname as constraint_name,
  pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.product_designer_map'::regclass
  and conname = 'designer_whatsapp_format_check';

-- ════════════════════════════════════════════════════════════════════
-- بعد التنفيذ، اختبر يدوياً (يجب أن يفشل كلٌّ منها):
-- ════════════════════════════════════════════════════════════════════
-- insert into product_designer_map
--   (merchant_id, salla_product_id, product_label, designer_name, designer_whatsapp)
-- values
--   ('<any-uuid>', 999999, 'اختبار', 'مصمم', '966111234567');  -- خط أرضي: يجب أن يُرفض
--
-- insert into product_designer_map
--   (merchant_id, salla_product_id, product_label, designer_name, designer_whatsapp)
-- values
--   ('<any-uuid>', 999999, 'اختبار', 'مصمم', '0501234567');  -- بدون 966: يجب أن يُرفض
--
-- insert into product_designer_map
--   (merchant_id, salla_product_id, product_label, designer_name, designer_whatsapp)
-- values
--   ('<any-uuid>', 999999, 'اختبار', 'مصمم', '+966501234567');  -- بـ +: يجب أن يُرفض
--
-- ويجب أن ينجح هذا:
-- insert into product_designer_map
--   (merchant_id, salla_product_id, product_label, designer_name, designer_whatsapp)
-- values
--   ('<any-uuid>', 999999, 'اختبار', 'مصمم', '966501234567');  -- جوال صحيح
