# Formak-AI-Context-v3.md — المرجع التقني الحالي

> **يُلغي هذا الملف Formak-AI-Context-v2.md بالكامل.** v2 كُتب كخطة "قبل التنفيذ" — والآن معظمه منفَّذ فعليًا. تغذية v2 لمحادثة AI جديدة قد تجعلها تعيد تنظيف/حذف أشياء منجزة أصلًا أو غير موجودة. هذا الملف يصف **ما هو موجود الآن فقط**، لا قائمة مهام.
>
> للقصة الكاملة وسجل الأخطاء السبعة: `Formak-Handoff.md`. للخطوات المتبقية 7-11 ببرومبتات جاهزة: `Formak-Phase7-to-Launch.md`.

## 0) الفكرة (ثابتة، بلا تغيير)

أداة B2B داخلية: عند وصول طلب سلة، صنّف هل يحتاج تخصيصًا (اسم في الملاحظة) ووجّهه تلقائيًا عبر واتساب للمصمم المسؤول عن ذلك المنتج تحديدًا. ليست form-builder للعميل — سلة توفر ذلك أصلًا.

## 1) الحالة الحالية — موجود بالفعل، لا تُعِد بناءه

| العنصر | الحالة |
|---|---|
| Next.js + Supabase + shadcn/ui + RTL/Tajawal | ✅ قائم |
| `survey-react-ui`/`survey-creator-react` | ✅ محذوف بالفعل، لا تحاول حذفه مجددًا |
| جدولا `forms`/`submissions` | ✅ محذوفان بالفعل، استُبدلا بالجدولين أدناه |
| Webhook + توقيع HMAC + استخراج Regex عربي + منطق التوجيه الكامل | ✅ مبني ومختبر (تفاصيل الإصلاحات الثلاثة في Handoff) |
| واتساب Cloud API + توكن دائم | ✅ متصل، رسالة حقيقية وصلت فعليًا |
| `/dashboard/mappings` | ❌ غير مبني — هذه نقطة العمل التالية |
| OAuth حقيقي مع متجر صديقك، نشر Vercel، اختبار حي | ❌ لم يبدأ |

## 2) المخطط الفعلي لقاعدة البيانات (كما هو منفَّذ الآن)

```sql
create table merchants (
  id uuid primary key default gen_random_uuid(),
  salla_store_id bigint unique not null,
  access_token text not null,
  refresh_token text not null,
  token_expires_at timestamptz not null,
  created_at timestamptz default now()
);

create table product_designer_map (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid references merchants(id) on delete cascade,
  salla_product_id bigint not null,
  product_label text not null,
  is_generic_variant boolean default false,
  designer_name text not null,
  designer_whatsapp text not null,          -- صيغة دولية: 9665xxxxxxxx
  created_at timestamptz default now()
);

create table order_routing_log (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid references merchants(id) on delete cascade,
  salla_order_id bigint not null,
  salla_product_id bigint not null,
  raw_note text,                            -- سلسلة فارغة '' لا null عند غياب الملاحظة
  personalization_detected boolean default false,
  extracted_name text,
  designer_whatsapp text,
  whatsapp_status text default 'pending',   -- pending | sent | failed | skipped
  created_at timestamptz default now()
);
```

⚠️ **لا يوجد عمود `status` في `order_routing_log`.** فقط `whatsapp_status`. أي خاصية `status` أخرى (كـ processed/skipped) هي خاصية داخل الذاكرة في كود المعالجة فقط، لا تُستعلم عنها في SQL.

## 3) آلية العمل — النسخة الصريحة (تسد غموض النسخة السابقة)

1. Webhook `order.created` → تحقق `X-Salla-Signature` (HMAC SHA256 + `crypto.timingSafeEqual`) → رجّع 200 فورًا، والباقي بعد الرد (waitUntil/background).
2. لكل عنصر بالطلب: ابحث `salla_product_id` في `product_designer_map` الخاص بالتاجر.
3. **لا تعيين موجود** → لا إرسال، `whatsapp_status='skipped'` في السجل.
4. **تعيين موجود** → طبّق regex (`بأسم|باسم|اسم\s*[:\-]`) على الملاحظة لضبط `personalization_detected`/`extracted_name`، ثم **أرسل رسالة واتساب 1:1 دائمًا — الإرسال غير مشروط إطلاقًا بوجود ملاحظة أو اكتشاف اسم.** الاكتشاف يُحدد فقط سطرًا إضافيًا داخل نفس الرسالة، لا قرار الإرسال نفسه.
5. **بلا ملاحظة إطلاقًا** (note فارغ/null) → عاملها تمامًا كملاحظة عامة بلا اسم: نفس مسار الإرسال الكامل في البند 4، فقط `personalization_detected=false`.
6. سجّل كل شيء في `order_routing_log` بصرف النظر عن النتيجة.

## 4) واتساب — القواعد المحدّثة

- **ممنوع WhatsApp Groups API** — لا يمكن ربطها بجروبات موجودة مسبقًا (تُنشئ جديدة فقط + تتطلب OBA). استخدم **1:1** دائمًا.
- **قالب `order_for_designer`** — بُني ووُصِل بتوكن حقيقي. عند بناء payload الإرسال: لا تُمرّر قيمة فارغة كمتغير Meta template (تُرفض/تُشوَّه). ملاحظة فارغة → مرّر `"لا توجد ملاحظات"`. سطر التنويه → مرّر النص الكامل فقط إذا `personalization_detected=true`، وإلا `"—"`.
- **التوكن:** System User + Never Expire. اختر أضيق صلاحية متاحة (رسائل/قوالب فقط) — تجنّب Full Control.

## 5) القواعد الذهبية (بلا تغيير)

- ممنوع `any` في TypeScript.
- كل مسار متعلق بسلة/واتساب server-side فقط؛ لا تكشف secrets أبدًا في الواجهة الأمامية.
- Supabase: Anon Key + RLS للواجهة (فعّله قبل الربط الحقيقي، معطّل حاليًا للتجربة المحلية)، Service Role Key فقط خلفيًا.
- لا تخترع endpoints من سلة — توقف واطلب التوثيق عند الشك.
- kebab-case للملفات. لا `useEffect` لجلب البيانات في Server Components.

## 6) القرار المؤجل: SaaS أم أداة لمتجر واحد؟

لا يزال غير محسوم. أقوى دليل حتى الآن: منافس حقيقي مدفوع (صقر، ~99 ريال/شهر) يحل نسخة أضعف (تنبيه أعمى، لا تصنيف ولا توجيه) — يثبت وجود سوق، لا يثبت شيوع نمط "جروب لكل منتج" تحديدًا. ⚠️ تجاهل أي أرقام "مستقل" أو "Make.com" وردت سابقًا — غير موثقة (تفصيل: Handoff، خطأ #6). الاستطلاع المباشر المطلوب (سؤال مغلق لـ5-10 تجار تخصيص فعليين) لم يُنفَّذ بعد.

## 7) ماذا بعد

راجع `Formak-Phase7-to-Launch.md` — المراحل 7 إلى 11 ببرومبتات جاهزة للنسخ مباشرة لـTrae.