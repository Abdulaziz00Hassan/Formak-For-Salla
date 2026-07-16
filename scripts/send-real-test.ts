/**
 * Send Real Test — إرسال رسالة واتساب حقيقية واحدة عبر Meta Cloud API
 *
 * ⚠️ يحمّل متغيرات .env.local تلقائياً قبل أي شيء آخر.
 * ⚠️ يستدعي `sendWhatsAppNotification` من المسار الإنتاجي مباشرة.
 * ⚠️ رسالة واحدة فقط، لرقم هاتفي الشخصي. لا Full Run.
 *
 * يُشغَّل بـ:
 *   node --experimental-strip-types scripts/send-real-test.ts
 *   # أو (Node 24+):
 *   node scripts/send-real-test.ts
 */

import { readFileSync } from 'node:fs';

// ─── 1) تحميل .env.local قبل أي استيراد حساس للـenv ─────────────────────

function loadEnvFile(relativePath: string): void {
  let content: string;
  try {
    content = readFileSync(relativePath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`⚠️ تعذّر قراءة ${relativePath}: ${msg}`);
    return;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.substring(0, eqIdx).trim();
    let value = line.substring(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.substring(1, value.length - 1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile('.env.local');

// ─── 2) الاستيراد بعد تحميل env — يضمن أن whatsapp-cloud.ts يجد env ─────

// @ts-ignore - dynamic import ضروري لاحترام ترتيب تحميل env قبل قراءة الـmodule
const cloudModule = await import('../app/lib/whatsapp-cloud.ts');
const sendWhatsAppNotification = cloudModule.sendWhatsAppNotification;

// ─── 3) المُدخلات كما طلبت ─────────────────────────────────────────────

const TEST_PARAMS = {
  to: '966556596406',
  orderId: 98765,
  productName: 'كوب زجاجي فاخر',
  note: 'يرجى كتابة الاسم بأسم: عبدالرحمن',
  hasPersonalization: true,
  extractedName: 'عبدالرحمن',
} as const;

// ─── 4) المُخرَج: دالة طباعة آمنة للقيم الحساسة ────────────────────────

function maskToken(token: string | undefined): string {
  if (!token) return '!!! مفقود';
  return `***محمَّل (${token.length} حرف)***`;
}

// ─── 5) main — تشغيل الاختبار وعرض النتيجة الكاملة ───────────────────

async function main(): Promise<void> {
  const W = 70;
  const sep = '='.repeat(W);

  console.log(sep);
  console.log('🧪 إرسال رسالة واتساب حقيقية واحدة عبر Meta Cloud API');
  console.log(sep);
  console.log('');

  console.log('📋 المُدخلات:');
  console.log(JSON.stringify(TEST_PARAMS, null, 2));
  console.log('');

  console.log('🔧 متغيرات البيئة المُحمَّلة من .env.local:');
  console.log(`  WHATSAPP_PHONE_NUMBER_ID          = ${process.env.WHATSAPP_PHONE_NUMBER_ID ?? '!!! مفقود'}`);
  console.log(`  WHATSAPP_API_VERSION              = ${process.env.WHATSAPP_API_VERSION ?? 'v21.0 (default)'}`);
  console.log(`  WHATSAPP_DESIGNER_NOTIFICATION_TEMPLATE = ${process.env.WHATSAPP_DESIGNER_NOTIFICATION_TEMPLATE ?? '!!! مفقود'}`);
  console.log(`  WHATSAPP_TEMPLATE_LANGUAGE        = ${process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? 'ar (default)'}`);
  console.log(`  WHATSAPP_ACCESS_TOKEN             = ${maskToken(process.env.WHATSAPP_ACCESS_TOKEN)}`);
  console.log('');

  console.log('🚀 جارٍ استدعاء Meta... (قد يستغرق حتى 5 ثوانٍ)');
  const startedAt = Date.now();
  console.log('');

  const result = await sendWhatsAppNotification(TEST_PARAMS);
  const elapsedMs = Date.now() - startedAt;

  console.log(sep);
  console.log('📨 النتيجة الكاملة من sendWhatsAppNotification:');
  console.log(sep);
  console.log(JSON.stringify(result, null, 2));
  console.log('');
  console.log(`⏱️  الزمن المستغرق: ${elapsedMs}ms`);
  console.log('');

  // ─── ملخص بشري ─────────────────────────────────────────────

  if (result.status === 'sent') {
    console.log(sep);
    console.log('✅ الرسالة أُرسلت بنجاح');
    console.log(sep);
    console.log(`📱 الرقم المُستقبِل:    ${TEST_PARAMS.to}`);
    console.log(`🆔 Message ID (wamid):  ${result.messageId}`);
    console.log(`🌐 HTTP Status:         ${result.httpStatus}`);
    console.log('');
    console.log('تحقق من واتسابك على الرقم 966556596406 — يجب أن تكون الرسالة قد وصلت.');
  } else {
    console.log(sep);
    console.log('❌ فشلت الرسالة');
    console.log(sep);
    console.log(`📱 الرقم المُستقبِل:    ${TEST_PARAMS.to}`);
    console.log(`🌐 HTTP Status:         ${result.httpStatus ?? 'لم يصل (استثناء قبل fetch)'}`);
    console.log(`💬 السبب:               ${result.reason}`);
    if (result.responseJson) {
      console.log('');
      console.log('🔍 جسم الاستجابة الكامل من Meta:');
      console.log(JSON.stringify(result.responseJson, null, 2));
    }
    console.log('');
    console.log('⚠️ الأسباب المحتملة الشائعة:');
    console.log('  - الكود 131047/132001: القالب غير معتمد أو اسم القالب خاطئ.');
    console.log('  - الكود 133004: انتهت نافذة الـ24 ساعة — يجب أن يرسل العميل أي رسالة');
    console.log('    لرقمك التجاري خلال آخر 24 ساعة قبل محاولة قالب.');
    console.log('  - الكود 131030: رقم الجوال غير مسجّل في واتساب.');
    console.log('  - الكود 190: Access Token منتهي/غير صالح.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('💥 خطأ غير متوقع في main():', err);
  process.exit(1);
});
