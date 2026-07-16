-- supabase-add-whatsapp-response-logging.sql
--
-- يضيف عمودين إلى order_routing_log لتسجيل الاستجابة الكاملة من Meta
-- (لتشخيص فشل الإرسال دون الحاجة لقراءة Vercel Logs).
--
-- ⚠️ آمن للتشغيل عدة مرات: `if not exists` يمنع الخطأ عند تطبيق مكرَّر.
--
-- كيف يُستخدم:
--   psql $DATABASE_URL -f supabase-add-whatsapp-response-logging.sql
--   أو في Supabase SQL Editor: الصق المحتوى ثم Run.
--
-- المرجع: Formak-Phase7-to-Launch-v2.md (المرحلة 8)
--          Formak-AI-Context-v3.md  (القسم 2 — مخطط order_routing_log)

alter table order_routing_log
  add column if not exists whatsapp_http_status int,
  add column if not exists whatsapp_response_json jsonb;

-- تأكيد سريع بعد التشغيل:
--   select column_name, data_type
--   from information_schema.columns
--   where table_name = 'order_routing_log'
--   order by ordinal_position;
