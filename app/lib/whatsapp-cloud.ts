/**
 * WhatsApp Cloud API Integration — Meta Official API
 *
 * يُرسل رسائل إشعار 1:1 للمصممين عبر WhatsApp Cloud API الرسمي من Meta.
 * يستخدم Message Template معتمد مسبقاً (يحتاج موافقة Meta على القالب قبل الاستخدام).
 *
 * ⚠️ server-side فقط — يجب ألّا يُستدعى من Client Components.
 *    السبب: يحتوي على `WHATSAPP_ACCESS_TOKEN` الذي لا يجب أن يُكشف للواجهة.
 *
 * ⚠️ Message Template: يجب تقديم القالب مسبقاً لـ Meta للموافقة من Meta Business Manager.
 *    القالب يجب أن يحوي 4 placeholders ({{1}}, {{2}}, {{3}}, {{4}}).
 *    الإرسال لن ينجح لرقم لم يبدأ محادثة في آخر 24 ساعة بدون قالب معتمد.
 *
 * ⚠️ منطق بناء المتغيرات (4 placeholders) مفوَّض كلياً إلى:
 *    `whatsapp-template-variables.ts` — ممنوع التكرار هنا.
 *
 * مرجع الوثيقة: Formak-Ai-Context-v3.md — القسم 4 (قواعد واتساب).
 */

import {
  buildTemplateVariables,
  toMetaTemplateParameters,
} from './whatsapp-template-variables.ts';

// ─── Types — الواجهات الصريحة لاستجابات Meta ───────────────────────────

/** Configuration required to call Meta WhatsApp Cloud API. */
interface WhatsAppCloudConfig {
  phoneNumberId: string;
  accessToken: string;
  apiVersion: string;
  templateName: string;
  templateLanguageCode: string;
}

/** Successful response from Meta after sending a template message. */
interface MetaSuccessResponse {
  messaging_product: 'whatsapp';
  contacts: Array<{
    input: string;
    wa_id: string;
  }>;
  messages: Array<{
    id: string;
    message_status?: string;
  }>;
}

/** Error response from Meta (HTTP 4xx/5xx). */
interface MetaErrorResponse {
  error: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

/** Meta always returns one or the other — discriminated union. */
type MetaSendMessageResponse = MetaSuccessResponse | MetaErrorResponse;

/** Type guard for distinguishing error responses. */
function isMetaErrorResponse(
  response: MetaSendMessageResponse
): response is MetaErrorResponse {
  return 'error' in response;
}

/** Type guard for AbortError (timeout). */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** Single template body parameter (text type). */
interface TemplateTextParameter {
  type: 'text';
  text: string;
}

/** Payload structure for sending a template message via Meta Cloud API. */
interface MetaTemplateMessagePayload {
  messaging_product: 'whatsapp';
  to: string;
  type: 'template';
  template: {
    name: string;
    language: { code: string };
    components: Array<{
      type: 'body';
      parameters: TemplateTextParameter[];
    }>;
  };
}

/** Parameters expected by the public function — must match order-processor.ts. */
export interface WhatsAppSendParams {
  to: string;
  orderId: number;
  productName: string;
  note: string;
  hasPersonalization: boolean;
  extractedName: string | null;
}

/**
 * نتيجة استدعاء Meta مع HTTP status والاستجابة الكاملة.
 *
 * - status='sent'   → أُرسلت الرسالة، `messageId` موجود، `httpStatus` رقمي (غالباً 200).
 * - status='failed' → فشلت المحاولة:
 *    * إن كانت Meta ردّت (4xx/5xx): `httpStatus` رقمي و `responseJson` يحوي جسم الاستجابة.
 *    * إن رمى الاستدعاء استثناء (timeout/network): `httpStatus` و `responseJson` هما `null`.
 *
 * الحقول القديمة (`messageId` / `reason`) محفوظة للتوافق العكسي مع الـSTUB
 * في `test-order-processor/route.ts` الذي يفكّكها بالاسم — لا تغيّر أسماءها.
 */
export type WhatsAppSendResult =
  | {
      status: 'sent';
      messageId: string;
      httpStatus: number;
      responseJson: MetaSendMessageResponse;
    }
  | {
      status: 'failed';
      reason: string;
      httpStatus: number | null;
      responseJson: MetaSendMessageResponse | null;
    };

// ─── Constants ──────────────────────────────────────────────────────────

const DEFAULT_API_VERSION = 'v21.0';
const DEFAULT_TEMPLATE_LANGUAGE = 'ar';
const META_REQUEST_TIMEOUT_MS = 5_000;
const META_BASE_URL = 'https://graph.facebook.com';

// ─── Config loader — قراءة المتغيرات البيئية ──────────────────────────

function buildWhatsAppCloudConfig(): WhatsAppCloudConfig {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const apiVersion = process.env.WHATSAPP_API_VERSION ?? DEFAULT_API_VERSION;
  const templateName = process.env.WHATSAPP_DESIGNER_NOTIFICATION_TEMPLATE;
  const templateLanguageCode =
    process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? DEFAULT_TEMPLATE_LANGUAGE;

  if (!phoneNumberId) {
    throw new Error('[WhatsApp] Missing env var: WHATSAPP_PHONE_NUMBER_ID');
  }
  if (!accessToken) {
    throw new Error('[WhatsApp] Missing env var: WHATSAPP_ACCESS_TOKEN');
  }
  if (!templateName) {
    throw new Error(
      '[WhatsApp] Missing env var: WHATSAPP_DESIGNER_NOTIFICATION_TEMPLATE'
    );
  }

  return {
    phoneNumberId,
    accessToken,
    apiVersion,
    templateName,
    templateLanguageCode,
  };
}

// ─── Phone number normalizer — تطبيع الأرقام السعودية ─────────────────

/**
 * يحوّل أرقام الجوال السعودية إلى الصيغة الدولية `9665xxxxxxxx` المطلوبة من Meta.
 *
 * يقبل: `05xxxxxxxx` | `5xxxxxxxx` | `9665xxxxxxxx` | `+9665xxxxxxxx`
 * يُرجع: `9665xxxxxxxx` (بدون علامة + وبدون مسافات)
 *
 * @returns الرقم بعد التطبيع، أو `null` إن كان غير صالح.
 */
function normalizePhoneNumber(input: string): string | null {
  if (typeof input !== 'string') return null;

  // استخرج الأرقام فقط
  const digits = input.replace(/\D/g, '');
  if (digits.length === 0) return null;

  // صيغة دولية كاملة: 9665xxxxxxxx (12 رقم)
  if (digits.startsWith('9665') && digits.length === 12) return digits;

  // صيغة محلية سعودية: 05xxxxxxxx (10 أرقام)
  if (digits.startsWith('05') && digits.length === 10) {
    return '966' + digits.substring(1);
  }

  // صيغة محلية بدون الصفر: 5xxxxxxxx (9 أرقام)
  if (digits.startsWith('5') && digits.length === 9) {
    return '966' + digits;
  }

  return null;
}

// ─── Template payload builder — استدعاء منطق المتغيرات الموحَّد ────────

/**
 * يبني معاملات جسم القالب بتفويض كامل إلى `whatsapp-template-variables.ts`.
 *
 * ⚠️ ممنوع تكرار منطق بناء المتغيرات هنا — يُستدعى كلياً من الدالة الموحَّدة
 *    في `whatsapp-template-variables.ts` لمنع الانحراف بين ملفين.
 */
function buildTemplateBodyParameters(
  params: WhatsAppSendParams
): TemplateTextParameter[] {
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

function buildMessagePayload(
  to: string,
  config: WhatsAppCloudConfig,
  params: WhatsAppSendParams
): MetaTemplateMessagePayload {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: config.templateName,
      language: { code: config.templateLanguageCode },
      components: [
        {
          type: 'body',
          parameters: buildTemplateBodyParameters(params),
        },
      ],
    },
  };
}

// ─── HTTP caller with timeout — استدعاء Meta مع مهلة ───────────────────

/** نتيجة HTTP كاملة من Meta — تُحفظ في `order_routing_log` للتشخيص. */
interface MetaHttpCallResult {
  status: number;
  body: MetaSendMessageResponse;
}

async function callMetaSendMessage(
  config: WhatsAppCloudConfig,
  payload: MetaTemplateMessagePayload
): Promise<MetaHttpCallResult> {
  const url = `${META_BASE_URL}/${config.apiVersion}/${config.phoneNumberId}/messages`;

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    META_REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const body = (await response.json()) as MetaSendMessageResponse;
    return { status: response.status, body };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Error classifier — تصنيف أخطاء Meta ───────────────────────────────

/**
 * خرائط لأكثر أكواد أخطاء Meta شيوعاً، مع رسائل واضحة بالعربية.
 * تُساعد في تشخيص المشاكل بسرعة من `order_routing_log.whatsapp_status`.
 */
const META_KNOWN_ERROR_CODES: Readonly<Record<number, string>> = {
  100: 'صيغة الطلب غير صحيحة',
  190: 'Access Token غير صالح أو منتهي الصلاحية',
  131030: 'رقم الجوال غير مسجّل في واتساب',
  131031: 'المستخدم لم يوافق على استلام رسائل من هذا الرقم',
  131032: 'المستخدم غير مسموح باستلام رسائل (يحتاج قالب معتمد)',
  131047: 'القالب غير معتمد لهذه الحالة',
  132000: 'عدد معاملات القالب غير مطابق للقالب الفعلي',
  132001: 'القالب غير موجود أو لم تتم الموافقة عليه بعد',
  132005: 'القالب متوقف مؤقتاً من Meta',
  132007: 'عدد معاملات القالب تجاوز الحد المسموح',
  133000: 'تم تجاوز حد الإرسال (Rate Limit)',
  133004: 'انتهت نافذة الـ 24 ساعة — يجب استخدام قالب معتمد',
  133005: 'تم تجاوز حد الرسائل اليومي لهذا الرقم',
  134100: 'خطأ عام في القالب — راجع Meta Business Manager',
};

function classifyMetaError(response: MetaErrorResponse): string {
  const { code, error_subcode, message, type } = response.error;
  const knownReason = META_KNOWN_ERROR_CODES[code];

  if (knownReason) {
    return `Meta #${code}: ${knownReason} (${message})`;
  }

  const subcodeStr =
    typeof error_subcode === 'number' ? `/${error_subcode}` : '';
  return `Meta ${type} #${code}${subcodeStr}: ${message}`;
}

function classifyUnexpectedError(err: unknown): string {
  if (isAbortError(err)) {
    return `Meta لم يرد خلال ${META_REQUEST_TIMEOUT_MS / 1000} ثوانٍ`;
  }
  if (err instanceof Error) {
    return `خطأ غير متوقع: ${err.message}`;
  }
  return 'خطأ غير معروف';
}

// ─── Public API — الدالة العامة المُصدَّرة ─────────────────────────────

/**
 * الدالة الرئيسية لإرسال إشعار واتساب 1:1 لمصمم.
 *
 * متوافقة تماماً مع `WhatsAppSendParams` و `WhatsAppSendResult` المُعرّفتين
 * في `app/lib/order-processor.ts`، لذا تُحقن مباشرة في `processOrderInBackground`.
 *
 * ⚠️ server-side فقط. لا تستدعيها من Client Components.
 *
 * @example
 * ```ts
 * const result = await sendWhatsAppNotification({
 *   to: '0501234567',
 *   orderId: 12345,
 *   productName: 'كوب مطبوع',
 *   note: 'بأسم: محمد',
 *   hasPersonalization: true,
 *   extractedName: 'محمد',
 * });
 *
 * if (result.status === 'sent') {
 *   console.log('Message ID:', result.messageId, 'HTTP:', result.httpStatus);
 * } else {
 *   console.error('Failed:', result.reason, 'HTTP:', result.httpStatus);
 * }
 * ```
 */
export async function sendWhatsAppNotification(
  params: WhatsAppSendParams
): Promise<WhatsAppSendResult> {
  // 1) تطبيع رقم الجوال — fail-fast بصيغة عربية واضحة
  const normalizedTo = normalizePhoneNumber(params.to);
  if (!normalizedTo) {
    return {
      status: 'failed',
      reason: `رقم جوال غير صالح: "${params.to}" (المتوقع صيغة سعودية 05xxxxxxxx)`,
      httpStatus: null,
      responseJson: null,
    };
  }

  // 2) تحميل الإعدادات من env — خطأ واضح عند نقصها
  let config: WhatsAppCloudConfig;
  try {
    config = buildWhatsAppCloudConfig();
  } catch (configErr) {
    const message =
      configErr instanceof Error ? configErr.message : 'Unknown config error';
    return {
      status: 'failed',
      reason: message,
      httpStatus: null,
      responseJson: null,
    };
  }

  // 3) بناء payload
  const payload = buildMessagePayload(normalizedTo, config, params);

  // 4) استدعاء Meta مع timeout
  let httpResult: MetaHttpCallResult;
  try {
    httpResult = await callMetaSendMessage(config, payload);
  } catch (callErr) {
    // 🐛 تسجيل أعمق لتشخيص فشل الاستدعاء (timeout, network, DNS, fetch refused)
    //   قبل هذا التعديل، Vercel logs كانت تُظهر httpStatus=null لكن بدون سبب واضح.
    //   الآن نسجّل الخطأ الكامل لتحديد ما إذا كان timeout من Meta أو
    //   مشكلة في Vercel Edge runtime (fetch from Edge is limited).
    //   ملاحظة: apiUrl غير متاح هنا — يُحسب داخل callMetaSendMessage.
    //   نسجّل الـ phone + endpoint phone_number_id من config كدليل.
    const errObj = callErr as { name?: string; message?: string; cause?: unknown; code?: string };
    console.error('[WhatsApp] ❌ callMetaSendMessage threw:');
    console.error(`[WhatsApp]    name              : ${errObj.name ?? '(unknown)'}`);
    console.error(`[WhatsApp]    message           : ${errObj.message ?? '(no message)'}`);
    console.error(`[WhatsApp]    code              : ${errObj.code ?? '(no code)'}`);
    console.error(`[WhatsApp]    phone_number_id   : ${config.phoneNumberId}`);
    console.error(`[WhatsApp]    phone (recipient) : ${normalizedTo}`);
    console.error(`[WhatsApp]    cause             : ${JSON.stringify(errObj.cause ?? null)}`);
    return {
      status: 'failed',
      reason: classifyUnexpectedError(callErr),
      httpStatus: null,
      responseJson: null,
    };
  }

  const { status: httpStatus, body: response } = httpResult;

  // 5) التمييز بين الاستجابة الناجحة والخاطئة
  if (isMetaErrorResponse(response)) {
    // 🐛 تسجيل أعمق لرؤية رد Meta الفعلي (status, code, message)
    console.error(`[WhatsApp] ❌ Meta returned error response (http=${httpStatus}):`);
    console.error(`[WhatsApp]    body: ${JSON.stringify(response, null, 2)}`);
    return {
      status: 'failed',
      reason: classifyMetaError(response),
      httpStatus,
      responseJson: response,
    };
  }

  // 6) استخراج message id — دفاعي في حالة استجابة ناقصة
  const firstMessage = response.messages[0];
  if (!firstMessage || typeof firstMessage.id !== 'string') {
    return {
      status: 'failed',
      reason: 'Meta أعاد استجابة بدون message id (استجابة غير متوقعة)',
      httpStatus,
      responseJson: response,
    };
  }

  console.log(
    `[WhatsApp] ✅ Sent to ${normalizedTo} | order #${params.orderId} | product="${params.productName}" | http=${httpStatus} | messageId=${firstMessage.id}`
  );

  return {
    status: 'sent',
    messageId: firstMessage.id,
    httpStatus,
    responseJson: response,
  };
}
