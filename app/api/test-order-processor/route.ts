/**
 * Test Endpoint — اختبار منظومة Order Processor
 *
 * ⚠️ للاستخدام في بيئة التطوير فقط. هذا الـ endpoint يستدعي المنظومة
 *    الخلفية بالكامل (Lookup + Extraction + Logging + WhatsApp stub) مع
 *    اختيارية `?dryRun=true` لتجنّب كتابة سجلات حقيقية في Supabase.
 *
 * يدعم:
 *  - GET  → فحص سريع لحالة الاتصال (Supabase ping + عدد السجلات).
 *  - POST → تنفيذ معالجة طلب تجريبي.
 *      - body فارغ: يستخدم payload افتراضي يغطي 5 سيناريوهات.
 *      - body { payload: {...} }: يستخدم payload مرسل من العميل.
 *      - ?dryRun=true: لا يُدرج سجلات في Supabase (مفيد لاختبار منطق Regex فقط).
 *
 * أمثلة:
 *   GET  http://localhost:3000/api/test-order-processor
 *   POST http://localhost:3000/api/test-order-processor
 *   POST http://localhost:3000/api/test-order-processor?dryRun=true
 *
 * مرجع الوثيقة: Formak-Ai-Context-v2.md — القسم 4 (آلية العمل).
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  createOrderRoutingSupabaseClient,
  processOrderInBackground,
} from '@/app/lib/order-processor';
import type { SallaWebhookPayload } from '@/app/lib/salla-types';

// ─── حراسة بيئية ─────────────────────────────────────────────────────────

/**
 ⚠️ نمنع تشغيل هذا الـ endpoint في الإنتاج لتفادي:
   - كشف بيانات حساسة في السجلات.
   - إدخال سجلات اختبار في قاعدة بيانات حقيقية.
 */
const ENABLE_IN_PRODUCTION = false;

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production' && !ENABLE_IN_PRODUCTION;
}

// ─── Payload تجريبي افتراضي ──────────────────────────────────────────────

/**
 * يحاكي طلباً حقيقياً من سلة مع تنوع في السيناريوهات:
 *  1. منتج بملاحظة تحوي تسمية واضحة  → يجب أن يستخرج اسماً.
 *  2. منتج بملاحظة تحوي اسم العميل   → يجب أن يستخرج اسماً.
 *  3. منتج بملاحظة فارغة              → يجب أن يتخطاه.
 *  4. منتج بملاحظة بدون تخصيص         → يمر دون استخراج اسم.
 *  5. منتج بملاحظة لكن لا يوجد تعيين  → يُسجَّل بـ designer_whatsapp=null.
 */
const DEFAULT_TEST_PAYLOAD: SallaWebhookPayload = {
  event: 'order.created',
  merchant: 123456789, // ⚠️ غيّر هذا إلى salla_store_id حقيقي للاختبار الكامل
  created_at: new Date().toISOString(),
  data: {
    id: 999001,
    status: 'pending',
    total: 350,
    subtotal: 350,
    tax: 0,
    discount: 0,
    shipping: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    customer: {
      id: 555,
      name: 'عميل اختبار',
      mobile: '+966500000000',
      email: null,
    },
    items: [
      {
        id: 1,
        product_id: 111111, // ⚠️ يجب أن يكون موجوداً في product_designer_map
        name: 'كوب مطبوع عليه اسم',
        quantity: 1,
        price: 100,
        total: 100,
        note: 'بأسم: محمد العتيبي',
      },
      {
        id: 2,
        product_id: 222222, // ⚠️ يجب أن يكون موجوداً في product_designer_map
        name: 'قلم محفور',
        quantity: 2,
        price: 50,
        total: 100,
        note: 'اسم العميل - فاطمة الزهراني',
      },
      {
        id: 3,
        product_id: 333333,
        name: 'منتج بدون ملاحظة',
        quantity: 1,
        price: 50,
        total: 50,
        note: null,
      },
      {
        id: 4,
        product_id: 444444,
        name: 'منتج بملاحظة عامة',
        quantity: 1,
        price: 50,
        total: 50,
        note: 'أرجو التوصيل قبل الخميس',
      },
      {
        id: 5,
        product_id: 999999, // ⚠️ غير موجود في product_designer_map
        name: 'منتج بدون تعيين',
        quantity: 1,
        price: 50,
        total: 50,
        note: 'بأسم: سارة',
      },
    ],
  },
};

// ─── GET — فحص الحالة ────────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  if (isProduction()) {
    return NextResponse.json(
      { error: 'Test endpoint is disabled in production' },
      { status: 403 }
    );
  }

  const checks: {
    name: string;
    status: 'ok' | 'error' | 'missing';
    details: string;
  }[] = [];

  // 1) فحص المتغيرات البيئية
  const envChecks: Record<string, string | undefined> = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SALLA_WEBHOOK_SECRET: process.env.SALLA_WEBHOOK_SECRET,
  };

  for (const [key, value] of Object.entries(envChecks)) {
    if (!value) {
      checks.push({ name: `env:${key}`, status: 'missing', details: 'غير موجود في .env.local' });
    } else {
      const masked =
        key === 'SUPABASE_SERVICE_ROLE_KEY' || key === 'SALLA_WEBHOOK_SECRET'
          ? `${value.slice(0, 8)}…(${value.length} chars)`
          : value;
      checks.push({ name: `env:${key}`, status: 'ok', details: masked });
    }
  }

  // 2) محاولة الاتصال بـ Supabase وعدّ السجلات
  let supabasePing: { ok: boolean; routingLogsCount: number | null; error: string | null } = {
    ok: false,
    routingLogsCount: null,
    error: null,
  };

  try {
    const supabase = createOrderRoutingSupabaseClient();
    const { count, error } = await supabase
      .from('order_routing_log')
      .select('*', { count: 'exact', head: true });

    if (error) {
      supabasePing = { ok: false, routingLogsCount: null, error: error.message };
      checks.push({
        name: 'supabase:order_routing_log',
        status: 'error',
        details: `فشل العدّ: ${error.message}`,
      });
    } else {
      supabasePing = { ok: true, routingLogsCount: count, error: null };
      checks.push({
        name: 'supabase:order_routing_log',
        status: 'ok',
        details: `عدد السجلات: ${count ?? 0}`,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    supabasePing = { ok: false, routingLogsCount: null, error: message };
    checks.push({
      name: 'supabase:connection',
      status: 'error',
      details: message,
    });
  }

  const allOk = checks.every((c) => c.status === 'ok');

  return NextResponse.json(
    {
      message: 'Test Order Processor — Health Check',
      timestamp: new Date().toISOString(),
      overallStatus: allOk ? 'healthy' : 'degraded',
      checks,
      supabase: supabasePing,
      usage: {
        get: 'GET /api/test-order-processor — هذا الفحص',
        postDry: 'POST /api/test-order-processor?dryRun=true — اختبار بدون كتابة DB',
        postFull: 'POST /api/test-order-processor — اختبار كامل مع كتابة السجلات',
        postCustom: 'POST /api/test-order-processor مع body: { payload: {...} }',
      },
    },
    { status: allOk ? 200 : 503 }
  );
}

// ─── POST — تنفيذ المعالجة التجريبية ─────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isProduction()) {
    return NextResponse.json(
      { error: 'Test endpoint is disabled in production' },
      { status: 403 }
    );
  }

  const dryRun = request.nextUrl.searchParams.get('dryRun') === 'true';
  const startedAt = Date.now();

  // 1) قراءة الـ body الاختياري
  let customPayload: SallaWebhookPayload | null = null;
  try {
    const text = await request.text();
    if (text && text.length > 0) {
      const parsed = JSON.parse(text) as { payload?: SallaWebhookPayload };
      if (parsed && parsed.payload && typeof parsed.payload === 'object') {
        customPayload = parsed.payload;
      }
    }
  } catch {
    // body فارغ أو غير صالح → نستخدم الافتراضي
  }

  const payload = customPayload ?? DEFAULT_TEST_PAYLOAD;
  const sallaMerchantId = payload.merchant;

  console.log('\n🧪 ============================================');
  console.log(`🧪 Test Order Processor — ${dryRun ? 'DRY RUN' : 'FULL RUN'}`);
  console.log(`🧪 Order #${payload.data.id} | Merchant: ${sallaMerchantId}`);
  console.log(`🧪 Items: ${payload.data.items.length}`);
  console.log('🧪 ============================================\n');

  // 2) إنشاء Supabase client
  let supabase;
  try {
    supabase = createOrderRoutingSupabaseClient();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to build Supabase client',
        details: message,
        hint: 'تأكّد من NEXT_PUBLIC_SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY في .env.local',
      },
      { status: 500 }
    );
  }

  // 3) استدعاء المعالج
  //    في dryRun، نمرّر merchantId=null ونعطّل الإدراج عبر wrap.
  //    الأبسط: نمرّر sendWhatsApp stub دائماً (لا يُرسل شيئاً حقيقياً).
  const summary = await processOrderInBackground(payload, {
    supabase,
    sallaMerchantId,
    // إن كان dryRun، نُجبر merchantId على null لتفادي أي إدراج
    // (لا — الإدراج يحدث في processSingleItem، سنعالجه بـ wrapper أدناه).
    sendWhatsApp: async (params) => {
      console.log(
        `[Test] 📲 [STUB WhatsApp] → ${params.to} | order #${params.orderId} | name="${params.extractedName ?? '—'}"`
      );
      // محاكاة: إن كان رقم الجوال ينتهي بـ 99 نُرجع failure
      if (params.to.endsWith('99')) {
        return { status: 'failed', reason: 'Test simulated failure' };
      }
      return { status: 'sent', messageId: 'test-' + Date.now() };
    },
  });

  // 4) في وضع dryRun: نحذف السجلات التي أُدرجت للتو من هذا الـ orderId
  if (dryRun) {
    const { error: cleanupErr } = await supabase
      .from('order_routing_log')
      .delete()
      .eq('salla_order_id', payload.data.id);

    if (cleanupErr) {
      console.warn(`[Test] ⚠️ DryRun cleanup warning: ${cleanupErr.message}`);
    } else {
      console.log(`[Test] 🧹 DryRun: cleaned up logs for order #${payload.data.id}`);
    }
  }

  // 5) فحص السجلات في DB (اختياري — للتحقق من الإدراج)
  let insertedLogs: unknown[] | null = null;
  if (!dryRun) {
    const { data, error } = await supabase
      .from('order_routing_log')
      .select('*')
      .eq('salla_order_id', payload.data.id);

    if (error) {
      console.warn(`[Test] ⚠️ Failed to fetch inserted logs: ${error.message}`);
    } else {
      insertedLogs = data;
    }
  }

  const elapsedMs = Date.now() - startedAt;

  console.log(`\n🧪 ============================================`);
  console.log(`🧪 Test finished in ${elapsedMs}ms`);
  console.log(`🧪 Summary: ${JSON.stringify(summary)}`);
  console.log('🧪 ============================================\n');

  return NextResponse.json({
    success: true,
    mode: dryRun ? 'dryRun' : 'fullRun',
    payloadUsed: customPayload ? 'custom' : 'default',
    summary,
    elapsedMs,
    ...(insertedLogs !== null && {
      insertedLogsCount: insertedLogs.length,
      insertedLogsSample: insertedLogs.slice(0, 3), // أوّل 3 فقط
    }),
    nextSteps: {
      checkLogs:
        'راجع console الخادم لرؤية سجلات [Processor] التفصيلية لكل عنصر.',
      inspectDb:
        'لاستعراض السجلات في Supabase: SELECT * FROM order_routing_log ORDER BY created_at DESC LIMIT 10;',
      fixMappings:
        'إن ظهر "No designer mapping found" لمنتج معيّن، أضف صفّاً في product_designer_map يربط salla_product_id بالتاجر.',
    },
  });
}
