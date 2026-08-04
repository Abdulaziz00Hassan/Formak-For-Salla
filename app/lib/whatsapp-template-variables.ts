/**
 * WhatsApp Template Variables — تجهيز متغيرات قالب `order_for_designer`
 *
 * دالة مستقلة (pure) مهمتها الوحيدة: تجهيز المتغيرات الـ4 التي يحتاجها قالب
 * Meta `order_for_designer` بصيغة آمنة 100% لـ Meta Cloud API.
 *
 * نص القالب (معتمد من Meta، فئة Marketing، لغة ar_AE):
 *   "وصلك طلب تخصيص جديد، رقم الطلب {{1}}، للمنتج {{2}}.
 *    ملاحظة العميل بخصوص التخصيص: {{3}}.
 *    حالة التخصيص المطلوب: {{4}}.
 *    يرجى مراجعة الطلب والبدء بالتنفيذ."
 *
 * ⚠️ القاعدة الصارمة: ممنوع تمرير أي قيمة فارغة أو `undefined` أو `null`
 *    كـ body parameter إلى Meta — الـ API يرفضها أو يشوّهها.
 *    هذه الدالة تضمن أن كل قيمة في المخرجات string غير فارغ (length >= 1).
 *
 * ⚠️ server-side فقط منطقياً (لا تُكشف secrets، لكن الدالة نفسها pure
 *    ولا تلامس أي env أو API — آمنة من الناحية النظرية للاستدعاء من أي مكان).
 *    تُستدعى من `whatsapp-cloud.ts` ضمن `buildMessagePayload` (server-side).
 *
 * ⚠️ لا تُلمس الـ STUB الحالي ولا منطق الإرسال في `whatsapp-cloud.ts` —
 *    هذه الدالة مستقلة تماماً.
 *
 * مرجع الوثيقة: Formak-Ai-Context-v3.md — القسم 4 (قواعد واتساب).
 */

// ─── Constants — ثوابت القيم الاحتياطية والحدود ─────────────────────────

/** نص احتياطي حين لا توجد ملاحظة أو فارغة. */
export const FALLBACK_NO_NOTE_TEXT = 'لا توجد ملاحظات';

/** نص "بلا تخصيص" حين personalizationDetected = false. */
export const FALLBACK_NO_PERSONALIZATION_BADGE = '—';

/** نص "تخصيص مكتشف" حين personalizationDetected = true. */
export const PERSONALIZATION_DETECTED_BADGE = '⚠️ يحتوي على تخصيص باسم';

/** شرطة واحدة حين لا يوجد اسم منتج. */
export const FALLBACK_NO_PRODUCT_LABEL = '—';

/** شرطة واحدة حين يكون رقم الطلب غير صالح. */
export const FALLBACK_NO_ORDER_ID = '—';

/** حد Meta الأقصى لطول نص body parameter — حماية من رفض الطلب. */
export const META_MAX_TEMPLATE_TEXT_LENGTH = 1024;

// ─── Types — الواجهات الصادرة ───────────────────────────────────────────

/**
 * متغيرات القالب الـ4 الجاهزة للإرسال إلى Meta.
 *
 * الترتيب يطابق تماماً placeholders القالب `order_for_designer`:
 *   {{1}} orderIdText         — رقم الطلب (النص الثابت يحوي "#" قبله)
 *   {{2}} productLabelText    — اسم المنتج (النص الثابت يحوي "for" قبله)
 *   {{3}} noteText            — نص الملاحظة (النص الثابت يحوي "Notes:" قبله)
 *   {{4}} personalizationBadge — شارة التخصيص (النص الثابت يحوي
 *                                 "Customization details:" قبله)
 */
export interface OrderForDesignerVariables {
  /** {{1}} — رقم الطلب كنص (مثال: "12345"). مضمون غير فارغ، بلا "#". */
  readonly orderIdText: string;
  /** {{2}} — اسم المنتج كما سيظهر للمصمم. مضمون غير فارغ، بلا "for". */
  readonly productLabelText: string;
  /** {{3}} — نص الملاحظة، أو `FALLBACK_NO_NOTE_TEXT` حين فارغة. مضمون غير فارغ، بلا "\n". */
  readonly noteText: string;
  /** {{4}} — شارة التخصيص. مضمون غير فارغ. */
  readonly personalizationBadge: string;
}

/** بنية body parameter كما تتوقعها Meta Cloud API. */
export interface MetaTemplateBodyParameter {
  readonly type: 'text';
  readonly text: string;
}

// ─── Helpers — مساعدات داخلية ───────────────────────────────────────────

/**
 * يحوّل أي قيمة إلى نص غير فارغ. إن كانت القيمة فارغة/غير نصية، يُعاد البديل.
 *
 * @param input  القيمة المُدخلة (أي نوع)
 * @param fallback  النص البديل المطلوب استخدامه حين `input` غير صالح
 * @returns نص مضمون غير فارغ بعد `trim`
 */
function safeNonEmptyString(input: unknown, fallback: string): string {
  if (typeof input !== 'string') return fallback;
  const trimmed = input.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed;
}

/**
 * يحوّل رقم الطلب إلى نص. يقبل: number | string | bigint.
 * للأرقام السالبة أو NaN أو Infinity → يستخدم البديل (لا يرمي).
 *
 * @param orderId  رقم الطلب (أي نوع شائع)
 * @returns نص مضمون غير فارغ (رقم فقط، بلا "#" — النص الثابت يحويها)
 */
function safeOrderIdText(orderId: unknown): string {
  if (typeof orderId === 'number' && Number.isFinite(orderId)) {
    return String(orderId);
  }
  if (typeof orderId === 'bigint') {
    return orderId.toString();
  }
  if (typeof orderId === 'string') {
    const trimmed = orderId.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return FALLBACK_NO_ORDER_ID;
}

/**
 * ينظّف نص الملاحظة من Meta:
 *  1. يستبدل أي `\n` (سطر جديد) بمسافة واحدة.
 *  2. يدمج المسافات المتتالية (أكثر من مسافة) في مسافة واحدة.
 *  3. يزيل المسافات في البداية والنهاية.
 *
 * ضروري لأن نص العميل الحر قد يحوي أسطرًا متعددة، و Meta template
 * variables لا تتسامح مع `\n` في حقل واحد (تشوّه العرض أو تُرفض).
 *
 * @param note  نص الملاحظة (مضمون غير فارغ)
 * @returns نص منظّف، مضمون غير فارغ، بلا `\n` ولا مسافات متتالية
 */
function cleanNoteText(note: string): string {
  return note
    .replace(/\n/g, ' ') // سطر جديد → مسافة
    .replace(/[ \t]+/g, ' ') // دمج المسافات/التابات المتتالية في مسافة واحدة
    .trim();
}

/**
 * يقطع النص إن تجاوز حد Meta (1024 حرف) مع إضافة `...` في النهاية.
 * يضمن أن النص بعد القطع لا يزال غير فارغ.
 *
 * @param text  النص الأصلي (مضمون غير فارغ)
 * @param max  الحد الأقصى
 * @returns نص مضمون غير فارغ بطول <= max
 */
function truncateSafely(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 3) {
    // حافة: لو max صغير جداً جداً (لا يحدث عملياً)، نعيد الشرطة بدلاً من ""
    return FALLBACK_NO_PERSONALIZATION_BADGE;
  }
  return text.substring(0, max - 3) + '...';
}

// ─── Public API — الدالة العامة المُصدَّرة ──────────────────────────────

/**
 * يبني متغيرات قالب `order_for_designer` بصيغة آمنة 100% لـ Meta.
 *
 * يضمن **عقوداً صارمة** على المُخرجات:
 *  1. كل حقل من الأربعة هو `string` غير فارغ (length >= 1).
 *  2. لا يمرّر `undefined`/`null`/`""` إلى Meta أبداً.
 *  3. لا يتجاوز طول أي حرف حد Meta (1024).
 *  4. `noteText` مضمون بلا `\n` ولا مسافات متتالية (لأن Meta template
 *     variables ترفض/تشوّه النصوص متعددة الأسطر).
 *  5. `orderIdText` بلا "#" (لأن النص الثابت يحويها).
 *  6. `productLabelText` بلا "for" (لأن النص الثابت يحويها).
 *  7. دالة pure — لا تلامس env، DB، شبكة، أو حالة خارجية.
 *
 * @param rawNote  ملاحظة الطلب من سلة (قد تكون `null`/`undefined`/`""` أو
 *                 تحوي `\n` ومسافات متتالية)
 * @param personalizationDetected  هل رصد Regex اسم تخصيص في الملاحظة
 * @param sallaOrderId  رقم الطلب من سلة (يحوَّل إلى نص)
 * @param productLabel  اسم/وصف المنتج كما سيظهر للمصمم
 *
 * @returns كائن `OrderForDesignerVariables` جاهز للتحويل إلى Meta API parameters
 *
 * @example
 * ```ts
 * // 1) ملاحظة عادية + تخصيص مكتشف
 * buildTemplateVariables('بأسم: خالد', true, 12345, 'كوب مطبوع');
 * // → { orderIdText: '12345', productLabelText: 'كوب مطبوع',
 * //     noteText: 'بأسم: خالد',
 * //     personalizationBadge: '⚠️ يحتوي على تخصيص باسم' }
 *
 * // 2) ملاحظة عادية + لا تخصيص
 * buildTemplateVariables('التوصيل قبل ٥', false, 12346, 'كوب مطبوع');
 * // → { ..., noteText: 'التوصيل قبل ٥', personalizationBadge: '—', ... }
 *
 * // 3) لا ملاحظة (null) + تخصيص (حالة حدية)
 * buildTemplateVariables(null, true, 12347, 'كوب مطبوع');
 * // → { ..., noteText: 'لا توجد ملاحظات',
 * //     personalizationBadge: '⚠️ يحتوي على تخصيص باسم', ... }
 *
 * // 4) لا ملاحظة (فارغة "") + لا تخصيص
 * buildTemplateVariables('', false, 12348, 'كوب مطبوع');
 * // → { ..., noteText: 'لا توجد ملاحظات', personalizationBadge: '—', ... }
 *
 * // 5) ملاحظة تحوي \n صريحاً (تنظيف تلقائي)
 * buildTemplateVariables('بأسم: خالد\nملاحظة إضافية', true, 12349, 'كوب');
 * // → { ..., noteText: 'بأسم: خالد ملاحظة إضافية' (بلا \n، مسافة واحدة), ... }
 * ```
 */
export function buildTemplateVariables(
  rawNote: string | null | undefined,
  personalizationDetected: boolean,
  sallaOrderId: number | string | bigint | null | undefined,
  productLabel: string | null | undefined
): OrderForDesignerVariables {
  // 1) الملاحظة: إن فارغة/null/undefined → "لا توجد ملاحظات" (ثابت، بلا تنظيف).
  //    وإلا → طبّق التنظيف (إزالة \n ودمج المسافات).
  const isNoteMissing =
    rawNote === null ||
    rawNote === undefined ||
    (typeof rawNote === 'string' && rawNote.trim().length === 0);

  const rawNoteText = isNoteMissing
    ? FALLBACK_NO_NOTE_TEXT
    : cleanNoteText(rawNote);

  // 2) رقم الطلب: أي نوع شائع → نص غير فارغ
  const rawOrderIdText = safeOrderIdText(sallaOrderId);

  // 3) اسم المنتج: فارغ/null → شرطة
  const rawProductLabelText = safeNonEmptyString(
    productLabel,
    FALLBACK_NO_PRODUCT_LABEL
  );

  // 4) شارة التخصيص: منطقي بسيط
  const rawPersonalizationBadge = personalizationDetected
    ? PERSONALIZATION_DETECTED_BADGE
    : FALLBACK_NO_PERSONALIZATION_BADGE;

  // 5) تطبيق حد Meta على كل حقل (defense-in-depth)
  return {
    orderIdText: truncateSafely(rawOrderIdText, META_MAX_TEMPLATE_TEXT_LENGTH),
    productLabelText: truncateSafely(
      rawProductLabelText,
      META_MAX_TEMPLATE_TEXT_LENGTH
    ),
    noteText: truncateSafely(rawNoteText, META_MAX_TEMPLATE_TEXT_LENGTH),
    personalizationBadge: truncateSafely(
      rawPersonalizationBadge,
      META_MAX_TEMPLATE_TEXT_LENGTH
    ),
  };
}

/**
 * يحوّل `OrderForDesignerVariables` إلى مصفوفة body parameters بصيغة Meta.
 *
 * الترتيب حرج ويطابق ترتيب placeholders القالب `order_for_designer`:
 *   {{1}} orderIdText → productLabelText → noteText → personalizationBadge
 *
 * ⚠️ حالياً القالب يحوي 4 placeholders فقط — لا حقول إضافية.
 *
 * @param variables  المُخرجات من `buildTemplateVariables`
 * @returns مصفوفة `MetaTemplateBodyParameter` بطول 4
 */
export function toMetaTemplateParameters(
  variables: OrderForDesignerVariables
): readonly MetaTemplateBodyParameter[] {
  return [
    { type: 'text', text: variables.orderIdText },
    { type: 'text', text: variables.productLabelText },
    { type: 'text', text: variables.noteText },
    { type: 'text', text: variables.personalizationBadge },
  ] as const;
}
