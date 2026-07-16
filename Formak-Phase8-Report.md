# Formak-Phase8-Report.md — تقرير المرحلة 8: قالب واتساب معتمد + إرسال حي ناجح

> **التاريخ:** 2026-07-16
> **الحالة:** ✅ مكتملة بالكامل — رسالة حقيقية وصلت لرقم المستخدم الشخصي
> **الخطوة التالية:** ⏸️ معلّقة — المرحلة 9 (OAuth مع سلة) لم تبدأ بناءً على طلب المستخدم
>
> هذا الملف يُضاف إلى: `Formak-AI-Context-v3.md` + `Formak-Phase7-to-Launch-v2.md` + `Formak-Handoff.md`
> كمرجع نهائي لما أنجز في المرحلة 8 بتفاصيل التنفيذ (لا الخطة فقط، بل ما طُبّق فعلياً).

---

## 1) ملخص تنفيذي

| البند | النتيجة |
|---|---|
| قالب Meta `order_for_designer` معتمد | ✅ بنص إنجليزي، 4 placeholders، فئة Utility، لغة `en` |
| الكود يبني المتغيرات الـ4 بأمان | ✅ مع تنظيف `\n` ودمج المسافات |
| STUB في المسار الإنتاجي (`whatsapp-cloud.ts`) | ✅ غير موجود أصلاً — المسار موصول حقيقياً |
| Migration لتسجيل استجابة Meta كاملة | ✅ طُبّق على Supabase، العمودان موجودان فعلياً |
| اختبار 5 حالات لوظيفة بناء المتغيرات | ✅ 5/5 نجح |
| `tsc --noEmit` | ✅ Exit 0، لا أخطاء |
| رسالة واتساب حقيقية واحدة | ✅ وصلت فعلاً، wamid صالح، HTTP 200 |

---

## 2) القالب المعتمد من Meta (التفاصيل الكاملة)

| البند | القيمة |
|---|---|
| **الاسم** | `order_for_designer` |
| **الفئة** | Utility (فارق سعري كبير عن Marketing) |
| **اللغة** | English (`en`) |
| **عدد placeholders** | 4 |
| **النص الثابت الكامل** | `Hello! Your design order #{{1}} for {{2}} has been received successfully. Notes: {{3}} Customization details: {{4}} Thank you for choosing us!` |
| **القيمة الافتراضية لـ {{3}}** | `لا توجد ملاحظات` (عربي — ثابت، يُمرَّر كما هو لـMeta) |
| **القيمة الافتراضية لـ {{4}}** | `None` (إن لم يُكتشف تخصيص) / `⚠️ Name customization requested` (إن وُجد) |

### الاستنتاج المهم
النص الثابت يحوي بالفعل `#` قبل `{{1}}` و`for` قبل `{{2}}` و`Notes:` قبل `{{3}}` و`Customization details:` قبل `{{4}}`.
**لذلك: المتغيرات المُرسلة لـ Meta يجب ألّا تحتوي على هذه البادئاتها** — وإلا سيظهر التكرار في الرسالة النهائية (مما كان أحد أخطاء التصميم في الإصدار الأول v1 من الكود).

---

## 3) الملفات المُعدَّلة (7 ملفات) + 1 ملف جديد

### 3.1) [app/lib/salla-types.ts](file:///c:/Users/abdal/Formak/app/lib/salla-types.ts) — Point 7 (إصلاح تمهيدي)

**تغييران:**

#### أ) `WhatsAppStatus` (السطر 84)
```ts
// قبل:
export type WhatsAppStatus = 'pending' | 'sent' | 'failed';
// بعد:
export type WhatsAppStatus = 'pending' | 'sent' | 'failed' | 'skipped';
```
**السبب:** `order-processor.ts` كان يكتب `'skipped'` في `whatsapp_status` لكن النوع لم يكن يسمح به — خلل type-safety صامت تم إصلاحه.

#### ب) `OrderRoutingLogRow` (السطور 86-101) — إضافة حقلين جديدين
```ts
whatsapp_http_status: number | null;
whatsapp_response_json: Record<string, unknown> | null;
```

---

### 3.2) [app/lib/whatsapp-template-variables.ts](file:///c:/Users/abdal/Formak/app/lib/whatsapp-template-variables.ts) — Point 1 (إعادة كتابة كاملة)

**التغييرات الجوهرية:**

| العنصر | قبل (v1) | بعد (v2) |
|---|---|---|
| عدد المتغيرات المُرسلة لـ Meta | 4 + `designerName` كحقل وصفي | **4 فقط** (designerName حُذف) |
| توقيع الدالة | `(note, pers, designerName, orderId, productLabel)` | `(note, pers, orderId, productLabel)` (4 معاملات) |
| `FALLBACK_NO_PERSONALIZATION_BADGE` | `'—'` (شرطة) | `'None'` |
| `PERSONALIZATION_DETECTED_BADGE` | `'⚠️ يحتوي على تخصيص باسم'` (عربي) | `'⚠️ Name customization requested'` (إنجليزي) |
| تنظيف `noteText` | `trim` فقط | `replace \n → space` ثم `دمج المسافات المتتالية` ثم `trim` |
| `OrderForDesignerVariables` interface | 5 حقول | 4 حقول |

**دالة التنظيف الجديدة [cleanNoteText](file:///c:/Users/abdal/Formak/app/lib/whatsapp-template-variables.ts#L123-L128):**
```ts
function cleanNoteText(note: string): string {
  return note
    .replace(/\n/g, ' ')      // سطر جديد → مسافة
    .replace(/[ \t]+/g, ' ')  // دمج المسافات/التابات المتتالية
    .trim();
}
```

**العقد الصريح (موثّق في JSDoc):**
1. كل حقل من الأربعة `string` غير فارغ (length ≥ 1).
2. لا يمرَّر `undefined`/`null`/`""` لـMeta.
3. لا يتجاوز طول أي حرف حد Meta (1024).
4. `noteText` مضمون بلا `\n` ولا مسافات متتالية.
5. `orderIdText` بلا `#` (لأن النص الثابت يحويها).
6. `productLabelText` بلا `for` (لأن النص الثابت يحويها).
7. دالة pure — لا تلامس env/DB/شبكة.

---

### 3.3) [app/lib/whatsapp-cloud.ts](file:///c:/Users/abdal/Formak/app/lib/whatsapp-cloud.ts) — Points 2 + 2b (تفويض + توسيع)

**التغيير 1: `import` بـextension لـESM (السطر 20-23)**
```ts
import {
  buildTemplateVariables,
  toMetaTemplateParameters,
} from './whatsapp-template-variables.ts';
```
**السبب:** Next.js يقبل الاستيراد بدون `.ts` لكن Node ESM (المُستعمل في السكربتات) يفشل. الإصلاح يجعل الكود يعمل في البيئتين.

**التغيير 2: [buildTemplateBodyParameters](file:///c:/Users/abdal/Formak/app/lib/whatsapp-cloud.ts#L210-L223) — حذف القديم + تفويض**
```ts
// قبل (v1) — منطق مكرّر يدوياً مع نص عربي:
function buildTemplateBodyParameters(params: WhatsAppSendParams): TemplateTextParameter[] {
  return [
    { type: 'text', text: String(params.orderId) },
    { type: 'text', text: params.productName },
    { type: 'text', text: truncateForTemplate(params.note) },
    { type: 'text', text: params.hasPersonalization ? 'نعم ⚠️' : 'لا' },
  ];
}

// بعد (v2) — تفويض خالص، صفر منطق مكرّر:
function buildTemplateBodyParameters(params: WhatsAppSendParams): TemplateTextParameter[] {
  return [
    ...toMetaTemplateParameters(
      buildTemplateVariables(
        params.note,
        params.hasPersonalization,
        params.orderId,
        params.productName
      )
    ),
  ];
}
```
**تأكيد الحذف:** `Grep` على `app/lib/whatsapp-cloud.ts` بحثاً عن `'نعم ⚠️'` أو `'لا'` → **No matches found**. النص القديم حُذف فعلياً.

**التغيير 3: `WhatsAppSendResult` (السطور 112-124) — توسيع بـhttpStatus + responseJson**
```ts
export type WhatsAppSendResult =
  | {
      status: 'sent';
      messageId: string;
      httpStatus: number;                    // جديد
      responseJson: MetaSendMessageResponse; // جديد
    }
  | {
      status: 'failed';
      reason: string;
      httpStatus: number | null;                    // جديد
      responseJson: MetaSendMessageResponse | null; // جديد
    };
```

**التغيير 4: [callMetaSendMessage](file:///c:/Users/abdal/Formak/app/lib/whatsapp-cloud.ts#L265-L293) — إرجاع HTTP status مع الجسم**
```ts
// قبل:
async function callMetaSendMessage(...): Promise<MetaSendMessageResponse> {
  ...
  return body;
}

// بعد:
interface MetaHttpCallResult { status: number; body: MetaSendMessageResponse; }
async function callMetaSendMessage(...): Promise<MetaHttpCallResult> {
  ...
  return { status: response.status, body };
}
```

**التغيير 5: [sendWhatsAppNotification](file:///c:/Users/abdal/Formak/app/lib/whatsapp-cloud.ts#L359-L436) — إرجاع httpStatus + responseJson في كل المسارات**

كل فروع الإرجاع (نجاح، خطأ Meta، استثناء، config مفقود، رقم غير صالح، رسالة ناقصة) تعيد الآن `httpStatus` و`responseJson` المناسبين (قد يكونان `null` حين لم يصل طلب HTTP).

---

### 3.4) [.env.local](file:///c:/Users/abdal/Formak/.env.local) — Point 3 (تغيير لغة القالب)

```diff
- WHATSAPP_TEMPLATE_LANGUAGE=ar
+ WHATSAPP_TEMPLATE_LANGUAGE=en
```

---

### 3.5) [supabase-add-whatsapp-response-logging.sql](file:///c:/Users/abdal/Formak/supabase-add-whatsapp-response-logging.sql) — Point 4a (جديد)

**محتوى الملف (24 سطر):**
```sql
alter table order_routing_log
  add column if not exists whatsapp_http_status int,
  add column if not exists whatsapp_response_json jsonb;
```
- `if not exists` يجعل التشغيل المتكرر آمناً.
- نسختُه أيضاً إلى `supabase/migrations/` ليتعرف عليه MCP tool.

---

### 3.6) [app/lib/order-processor.ts](file:///c:/Users/abdal/Formak/app/lib/order-processor.ts) — Point 5 (تحديث logRouting)

**التغيير 1: [LogRoutingRow interface](file:///c:/Users/abdal/Formak/app/lib/order-processor.ts#L411-L424) — إضافة الحقلين**
```ts
interface LogRoutingRow {
  // ... الحقول السابقة
  whatsapp_http_status: number | null;
  whatsapp_response_json: Record<string, unknown> | null;
}
```

**التغيير 2: [logRouting](file:///c:/Users/abdal/Formak/app/lib/order-processor.ts#L432-L462) — كتابة الحقلين**
```ts
const { error } = await supabase.from('order_routing_log').insert({
  // ... الحقول السابقة
  whatsapp_http_status: row.whatsapp_http_status,
  whatsapp_response_json: row.whatsapp_response_json,
});
```

**التغيير 3: [processSingleItem](file:///c:/Users/abdal/Formak/app/lib/order-processor.ts#L204-L268) — استخراج الحقلين من نتيجة sendWhatsApp**

أُعيد هيكلة الـscope: `let whatsappHttpStatus` و`let whatsappResponseJson` تُعرَّف خارج `if/else` لأن `logRouting` أدناه يحتاج قراءتهما لاحقاً.

```ts
let whatsappHttpStatus: number | null = null;
let whatsappResponseJson: Record<string, unknown> | null = null;

if (!mapping) {
  result.status = 'skipped';
  result.whatsappStatus = 'skipped';
  // (تظل القيم null — صحيح، لم يُرسل طلب HTTP)
} else {
  // ... lookup + sendWhatsApp
  try {
    const whatsappResult = await deps.sendWhatsApp({...});
    // استخراج httpStatus/responseJson من النتيجة
    if ('httpStatus' in whatsappResult) {
      whatsappHttpStatus = typeof whatsappResult.httpStatus === 'number' 
        ? whatsappResult.httpStatus : null;
    }
    if ('responseJson' in whatsappResult) {
      whatsappResponseJson = (whatsappResult.responseJson && typeof whatsappResult.responseJson === 'object')
        ? whatsappResult.responseJson : null;
    }
    // ... تحديث result.whatsappStatus
  } catch (whatsappErr) {
    // ... تظل القيم null
  }
}

// استدعاء logRouting خارج if/else — يصل للحقلين دائماً
const logResult = await logRouting(deps.supabase, merchantId, {
  // ...
  whatsapp_http_status: whatsappHttpStatus,
  whatsapp_response_json: whatsappResponseJson,
});
```

**التوافق العكسي:** `in` checks تحمي ضد STUB قديم لا يحوي الحقلين.

---

### 3.7) [scripts/test-template-variables.ts](file:///c:/Users/abdal/Formak/scripts/test-template-variables.ts) — Point 6 (توسيع الاختبارات)

**التغييرات:**
- أُضيفت **الحالة 5**: `rawNote = "بأسم: خالد\nملاحظة إضافية   بمسافات   زائدة"` (نص فيه `\n` صريح + مسافات متتالية).
- تحديث `TestExpectation` interface بأربعة حقول منفصلة (`expectedOrderIdText`, `expectedProductLabelText`, `expectedNoteText`, `expectedPersonalizationBadge`).
- تحديث `renderVariables` لطباعة `{{1..4}}` صراحة.
- `checkCase` يفحص **8 شروط** بدل 4:
  1. تطابق `{{1}} orderIdText` مع المتوقع
  2. تطابق `{{2}} productLabelText` مع المتوقع
  3. تطابق `{{3}} noteText` مع المتوقع
  4. تطابق `{{4}} personalizationBadge` مع المتوقع
  5. **لا `\n`** في الحقول المطلوبة
  6. **لا `undefined`/`null`/`[object Object]`** في النصوص
  7. **`{{1}} orderIdText` بلا `#`**
  8. **`{{2}} productLabelText` بلا `for`**

---

### 3.8) [scripts/send-real-test.ts](file:///c:/Users/abdal/Formak/scripts/send-real-test.ts) — **جديد بالكامل**

سكربت اختبار سريع (84 سطر) يُرسل رسالة واتساب حقيقية واحدة فقط عبر `sendWhatsAppNotification` (المسار الإنتاجي، لا STUB).

**المُدخلات الثابتة:**
```ts
const TEST_PARAMS = {
  to: '966556596406',
  orderId: 98765,
  productName: 'كوب زجاجي فاخر',
  note: 'يرجى كتابة الاسم بأسم: عبدالرحمن',
  hasPersonalization: true,
  extractedName: 'عبدالرحمن',
} as const;
```

**خطوات السكربت:**
1. `loadEnvFile('.env.local')` — تحميل المتغيرات قبل أي استيراد.
2. `await import('../app/lib/whatsapp-cloud.ts')` — استيراد ديناميكي بعد تحميل env.
3. طباعة المدخلات والمتغيرات المحملة (مع إخفاء الـtoken).
4. استدعاء `sendWhatsAppNotification(TEST_PARAMS)`.
5. طباعة النتيجة الكاملة + الـwamid + الـHTTP status.

**التشغيل:**
```bash
node --experimental-strip-types scripts/send-real-test.ts
```

---

## 4) الـMigration على Supabase

**التشغيل:** المستخدم نفّذ محتوى `supabase/migrations/supabase-add-whatsapp-response-logging.sql` يدوياً في Supabase SQL Editor. النتيجة: `Success. No rows returned` (سلوك `ALTER TABLE` الطبيعي).

**التحقق (استعلامان نفّذهما المستخدم وأكّد نتيجتهما):**

### الاستعلام المُصفّى (مُقدَّم منّي)
```sql
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'order_routing_log'
  and column_name in ('whatsapp_http_status', 'whatsapp_response_json')
order by column_name;
```

**النتيجة المؤكَّدة:**
| column_name | data_type | is_nullable |
|---|---|---|
| `whatsapp_http_status` | `integer` | YES |
| `whatsapp_response_json` | `jsonb` | YES |

### الاستعلام الشامل (مُقدَّم منّي)
```sql
select column_name, data_type
from information_schema.columns
where table_name = 'order_routing_log'
order by ordinal_position;
```

**النتيجة المؤكَّدة:** الجدول الآن 12 عموداً بالترتيب:
```
id, merchant_id, salla_order_id, salla_product_id, raw_note,
personalization_detected, extracted_name, designer_whatsapp,
whatsapp_status, created_at,
whatsapp_http_status, whatsapp_response_json   ← العمودان الجديدان في النهاية
```

الـmigration نُفّذ فعلياً.

---

## 5) نتائج الاختبارات

### 5.1) `tsc --noEmit` (TypeScript 5.9.3)

```
الإصدار: 5.9.3
الأمر:   node node_modules/typescript/bin/tsc --noEmit
stdout:  (فارغ)
stderr:  (فارغ)
exit:    0
```

**النتيجة:** ✅ لا أخطاء نوعية، لا تحذيرات. المشروع كاملاً يترجم بنجاح.

---

### 5.2) اختبار 5 حالات لـ`buildTemplateVariables`

| # | المُدخل `rawNote` | المُدخل `pers` | `{{1}} orderIdText` | `{{2}} productLabelText` | `{{3}} noteText` | `{{4}} personalizationBadge` | النتيجة |
|---|---|---|---|---|---|---|---|
| 1 | `"بأسم: خالد"` | true | `"12345"` | `"كوب مطبوع"` | `"بأسم: خالد"` | `"⚠️ Name customization requested"` | ✅ |
| 2 | `"التوصيل قبل الساعة ٥ مساءً"` | false | `"12346"` | `"كوب مطبوع"` | `"التوصيل قبل الساعة ٥ مساءً"` | `"None"` | ✅ |
| 3 | `null` | true | `"12347"` | `"كوب مطبوع"` | `"لا توجد ملاحظات"` | `"⚠️ Name customization requested"` | ✅ |
| 4 | `""` (فارغ) | false | `"12348"` | `"كوب مطبوع"` | `"لا توجد ملاحظات"` | `"None"` | ✅ |
| 5 | `"بأسم: خالد\nملاحظة إضافية   بمسافات   زائدة"` | true | `"12349"` | `"كوب مطبوع"` | `"بأسم: خالد ملاحظة إضافية بمسافات زائدة"` | `"⚠️ Name customization requested"` | ✅ |

**الحالة 5 تحديداً (الأهم):** `\n` صريح في المدخل → استُبدل بمسافة، المسافات الثلاث المتتالية (`   ` بين "إضافية" و"بمسافات" و"زائدة") دُمجت في مسافة واحدة. **الناتج نظيف تماماً — لا `\n` ولا مسافات متتالية في أي قيمة.**

**شروط الـ8 لكل حالة:** كل الحالات الـ5 استوفت الشروط الـ8 بما فيها:
- ✅ `{{1}} orderIdText` بلا `#`
- ✅ `{{2}} productLabelText` بلا `"for"`

**ملخص:** `5 نجح / 0 فشل من أصل 5 حالات` — [scripts/test-output.txt](file:///c:/Users/abdal/Formak/scripts/test-output.txt) يحوي الناتج الكامل.

---

## 6) نتيجة الإرسال الحقيقي (الحظة التأكيد)

**التشغيل:**
```bash
node --experimental-strip-types scripts/send-real-test.ts
```

**الاستجابة من Meta:**

```json
{
  "status": "sent",
  "messageId": "wamid.HBgMOTY2NTU2NTk2NDA2FQIAERgSMzgwMzE1RjY3NTVGRURGODc0AA==",
  "httpStatus": 200,
  "responseJson": {
    "messaging_product": "whatsapp",
    "contacts": [{ "input": "966556596406", "wa_id": "966556596406" }],
    "messages": [{
      "id": "wamid.HBgMOTY2NTU2NTk2NDA2FQIAERgSMzgwMzE1RjY3NTVGRURGODc0AA==",
      "message_status": "accepted"
    }]
  }
}
```

| البند | القيمة |
|---|---|
| HTTP Status | `200` |
| wamid | `wamid.HBgMOTY2NTU2NTk2NDA2FQIAERgSMzgwMzE1RjY3NTVGRURGODc0AA==` |
| message_status | `accepted` (Meta قبلت — ستُسلَّم) |
| الزمن | 2718ms |
| الرقم المُستقبِل | `966556596406` (شخصي) |

**تأكيد المستخدم:** "وصلت الرسالة." — الرسالة الفعلية التي ظهرت في واتسابه:
> Hello! Your design order #98765 for كوب زجاجي فاخر has been received successfully. Notes: يرجى كتابة الاسم بأسم: عبدالرحمن Customization details: ⚠️ Name customization requested Thank you for choosing us!

النص كاملاً، بدون أي متغير فارغ أو `undefined`، بدون `#` مكررة، بدون `for` مكررة. ✅

---

## 7) معايير النجاح — كل المعايير محققة

| المعيار (من الخطة الأصلية) | الحالة | الدليل |
|---|---|---|
| حالة القالب في Meta Business Manager = Approved | ✅ (خارج هذه الجلسة — مُقدَّم من المستخدم) | نجح الإرسال |
| 4/4 اختبارات دالة بناء المتغيرات نجحت | ✅ 5/5 | [scripts/test-output.txt](file:///c:/Users/abdal/Formak/scripts/test-output.txt) |
| رسالة تجريبية وصلت لرقم المستخدم بنص صحيح | ✅ | تأكيد المستخدم نصّاً |
| `tsc --noEmit` = Exit 0 | ✅ | stdout فارغ، exit 0 |
| Trae عرض السطر المحدد الذي عطّل STUB | ✅ (لا STUB موجود أصلاً) | Grep: `'نعم ⚠️'` → No matches |

**معايير إضافية تم التحقق منها:**
- ✅ `{{1}} orderIdText` بلا `#` مكررة (النص الثابت يحويها).
- ✅ `{{2}} productLabelText` بلا `for` مكررة (النص الثابت يحويها).
- ✅ `{{3}} noteText` بلا `\n` (تم تنظيفه).
- ✅ `{{3}} noteText` بلا مسافات متتالية (تم دمجها).
- ✅ `{{4}} personalizationBadge` يطابق `None`/`⚠️ Name...` بدقّة.
- ✅ عمودا `whatsapp_http_status` و`whatsapp_response_json` موجودان فعلياً في `order_routing_log` على Supabase.
- ✅ `whatsapp_status='skipped'` أصبح نوعياً صحيحاً في `WhatsAppStatus`.

---

## 8) الأخطاء/العقبات التي واجهتها أثناء التنفيذ + كيف حُلّت

| # | المشكلة | الحل |
|---|---|---|
| 1 | `order-processor.ts` يكتب `'skipped'` لكن `WhatsAppStatus` لا يحويه | أُضيف `'skipped'` للنوع في `salla-types.ts` (Point 7) — إصلاح تمهيدي قبل أي تعديل آخر |
| 2 | متغيرات `let` معلّقة خارج scope الـif/else | أُعيد ترتيب الكود: التعريف خارج الـif/else، التحديث داخله |
| 3 | `whatsapp-cloud.ts` يستورد بدون `.ts` extension → Node ESM يفشل | أُضيف `.ts` للاستيراد — متوافق مع Next.js أيضاً |
| 4 | `whatsapp_response_json` نوعه Meta response المعقّد | استخدمت `Record<string, unknown>` في `OrderRoutingLogRow` للسماح بأي بنية JSON |
| 5 | STUB يتعطل (الذي تركناه في `test-order-processor/route.ts` بسبب تعليمات سابقة) | **غير مُحَل** — المستخدم أمرَ بتركه. الـSTUB في ملف منفصل، لا تأثير على المسار الإنتاجي |

---

## 9) الخطوة التالية ⏸️

**لم تبدأ** بناءً على طلب المستخدم الصريح: "أنهي الخطوة 8 ولا تبدأ الخطة 9".

**المرحلة 9 (OAuth مع سلة)** معلّقة. عند البدء، يجب:
- ⛔ التحقق من حالة توثيق حساب الشركاء بسلة (Gate 1)
- ⛔ نشر Vercel أولي (Gate 2 — أو ngrok) لتلقي callback
- 📋 مراجعة [Formak-Phase7-to-Launch-v2.md §المرحلة 9](file:///c:/Users/abdal/Formak/Formak-Phase7-to-Launch-v2.md) للبرومبتات الجاهزة

---

## 10) فهرس سريع للملفات

| الملف | نوع التغيير | الغرض |
|---|---|---|
| [app/lib/salla-types.ts](file:///c:/Users/abdal/Formak/app/lib/salla-types.ts) | تعديل | إضافة `'skipped'` للحقل + حقول HTTP |
| [app/lib/whatsapp-template-variables.ts](file:///c:/Users/abdal/Formak/app/lib/whatsapp-template-variables.ts) | إعادة كتابة | دعم القالب الإنجليزي + تنظيف `\n` |
| [app/lib/whatsapp-cloud.ts](file:///c:/Users/abdal/Formak/app/lib/whatsapp-cloud.ts) | تعديل كبير | تفويض + httpStatus/responseJson + ESM fix |
| [app/lib/order-processor.ts](file:///c:/Users/abdal/Formak/app/lib/order-processor.ts) | تعديل | logRouting يكتب الحقلين الجديدين |
| [.env.local](file:///c:/Users/abdal/Formak/.env.local) | تعديل سطر واحد | `WHATSAPP_TEMPLATE_LANGUAGE: ar → en` |
| [supabase-add-whatsapp-response-logging.sql](file:///c:/Users/abdal/Formak/supabase-add-whatsapp-response-logging.sql) | جديد | Migration: عمودا HTTP + response JSON |
| [supabase/migrations/supabase-add-whatsapp-response-logging.sql](file:///c:/Users/abdal/Formak/supabase/migrations/supabase-add-whatsapp-response-logging.sql) | جديد (نسخة) | نسخة لـMCP tool |
| [scripts/test-template-variables.ts](file:///c:/Users/abdal/Formak/scripts/test-template-variables.ts) | تعديل كبير | الحالة 5 + 8 شروط فحص |
| [scripts/send-real-test.ts](file:///c:/Users/abdal/Formak/scripts/send-real-test.ts) | جديد | إرسال رسالة حقيقية واحدة |
| [scripts/test-output.txt](file:///c:/Users/abdal/Formak/scripts/test-output.txt) | مُحدَّث آلياً | ناتج اختبار الحالات الخمس |
| [scripts/tsc-output-new.txt](file:///c:/Users/abdal/Formak/scripts/tsc-output-new.txt) | جديد | تأكيد tsc بدون أخطاء |

---

## 11) ملاحظات ختامية

1. **الكود الإنتاجي لا يحوي STUB.** `whatsapp-cloud.ts` يستدعي Meta Cloud API مباشرة في كل الأوقات. STUB موجود فقط في `app/api/test-order-processor/route.ts` (endpoint اختبار، خارج المسار الإنتاجي) — لم يُلمس بأمر المستخدم.

2. **التوافق العكسي محفوظ.** `order-processor.ts` يستخدم `in` checks لاستخراج `httpStatus`/`responseJson` بأمان — لو STUB قديم أُعيد بحقن نتيجة بدون هذين الحقلين، الكود يواصل العمل بهدوء (يكتب `null`).

3. **Logging كامل متاح الآن.** كل إرسال (نجح أو فشل) يُسجَّل في `order_routing_log` مع HTTP status + جسم الاستجابة الكامل من Meta. لتشخيص أي فشل مستقبلي: `SELECT whatsapp_status, whatsapp_http_status, whatsapp_response_json FROM order_routing_log ORDER BY created_at DESC LIMIT 10;`

4. **السلامة قبل السرعة.** أوقفت كل الإرسالات الحقيقية إلى أن طلب المستخدم ذلك صراحة. المرحلة 8 انتهت بإرسال **رسالة واحدة فقط** لرقم المستخدم الشخصي — لا Full Run، لا رسائل للمصممين.

---

**✅ المرحلة 8 مكتملة. ⏸️ المرحلة 9 معلّقة بناءً على طلب المستخدم.**
