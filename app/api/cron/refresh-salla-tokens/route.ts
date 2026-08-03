/**
 * Salla OAuth — Token Refresh Cron Endpoint
 *
 * مجدول عبر Vercel Cron (vercel.json) ليعمل مرة واحدة يومياً.
 * الغرض: تجديد `access_token` لكل تاجر قبل انتهاء صلاحيته، حتى يظل
 * الـ Webhook handler قادراً على استدعاءات سلة الخلفية.
 *
 * ⚠️ آلية عمل نافذة الـ3 أيام كـ mutex (قرار مدروس):
 *    - التوكن صالح 14 يوماً (مدة `expires_in` الفعلية من سلة).
 *    - Vercel Hobby يضمن تنفيذ cron مرة واحدة يومياً فقط.
 *    - العتبة `token_expires_at < now() + 3 days` تعني أن التاجر يدخل
 *      قائمة التحديث فقط قبل انتهاء صلاحيته بـ3 أيام.
 *    - بمجرد التجديد، `token_expires_at` يقفز 14 يوماً للأمام، فيخرج
 *      فوراً من النافذة. لو تكرر تشغيل cron بنفس اليوم (يدوياً مثلاً)،
 *      لن يعثر على مرشحين جدد — تكرار استخدام `refresh_token` مادياً
 *      مستحيل بهذا التصميم. يكفي تماماً عن قفل mutex حقيقي.
 *
 * ⚠️ المصادقة:
 *    - Vercel يضيف `Authorization: Bearer ${CRON_SECRET}` تلقائياً لكل cron.
 *    - `CRON_SECRET` يُولَّد ويُحقن تلقائياً عند تفعيل cron — لا تُنشئه
 *      يدوياً كمتغير بيئة في Vercel dashboard.
 *    - فشل المطابقة → 401 فوراً قبل أي عمل آخر.
 *
 * ⚠️ الاستجابة (ملخص JSON):
 *    - `candidates`: عدد الصفوف داخل نافذة الـ3 أيام (ما عالجناه فعلياً).
 *    - `updated`: عدد من نجح تجديد توكناتهم.
 *    - `failed`: عدد من فشل (تحتاج تدخل يدوي — إعادة تفويض كاملة).
 *    - `not_needed`: عدد التجار المسجَّلين الذين لم يحنّ وقتهم بعد.
 *    - `results`: تفاصيل كل صف (id + status + سبب الفشل إن وُجد).
 *
 * مرجع: Formak-Ai-Context-v3.md + Formak-Phase7-to-Launch-v2.md (Phase 10).
 */

import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createOrderRoutingSupabaseClient } from '@/app/lib/order-processor';

// ⚠️ ملاحظة: لا نُصدّر `dynamic = 'force-dynamic'` ولا `runtime = 'nodejs'`
// لأن Next.js 16 + cacheComponents (مفعّل في next.config.ts) يرفضهما.
// المسار ديناميكي بطبيعته (يقرأ Authorization header + env vars) فلا حاجة
// لإعلان ذلك صراحة.

const SALLA_TOKEN_ENDPOINT = 'https://accounts.salla.sa/oauth2/token';

/** نافذة التحديث: 3 أيام قبل انتهاء الصلاحية. */
const REFRESH_WINDOW_DAYS = 3;
const REFRESH_WINDOW_MS = REFRESH_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// ─── Types ───────────────────────────────────────────────────────────────

interface MerchantRow {
  id: string;
  /**
   * ⚠️ PostgREST يُرجع أعمدة bigint كنص JSON ("244457341") لا رقم —
   *    احترازاً من فقدان الدقة. نتعامل معه كـ string في كل مكان.
   */
  salla_store_id: string;
  refresh_token: string;
  token_expires_at: string;
}

interface SallaRefreshSuccess {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

interface SallaRefreshErrorPayload {
  error: string;
  error_description?: string;
}

interface RefreshAttemptResult {
  success: boolean;
  newTokens?: SallaRefreshSuccess;
  error?: string;
}

interface ProcessResult {
  merchantId: string;
  sallaStoreId: string;
  status: 'updated' | 'failed';
  reason?: string;
}

// ─── Type guards ─────────────────────────────────────────────────────────

function isSallaRefreshSuccess(value: unknown): value is SallaRefreshSuccess {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['access_token'] === 'string' &&
    v['access_token'].length > 0 &&
    typeof v['refresh_token'] === 'string' &&
    v['refresh_token'].length > 0 &&
    typeof v['expires_in'] === 'number' &&
    Number.isFinite(v['expires_in'])
  );
}

function isMerchantRow(value: unknown): value is MerchantRow {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    v['id'].length > 0 &&
    typeof v['salla_store_id'] === 'string' &&
    v['salla_store_id'].length > 0 &&
    typeof v['refresh_token'] === 'string' &&
    v['refresh_token'].length > 0 &&
    typeof v['token_expires_at'] === 'string' &&
    v['token_expires_at'].length > 0
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * يقرأ بيانات اعتماد سلة من البيئة.
 * ⚠️ server-side فقط — لا تُسرَّب أبداً.
 */
function readSallaCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.SALLA_CLIENT_ID;
  const clientSecret = process.env.SALLA_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * يحسب وقت الانتهاء من `expires_in` (بالثواني) — مطابق لمنطق
 * `linkTokensToPendingMerchant` بـ /api/auth/callback.
 */
function computeExpiresAtIso(expiresInSeconds: number): string {
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
}

/**
 * يجلب كل التجار الذين يدخلون نافذة الـ3 أيام ولديهم `refresh_token` صالح.
 */
async function fetchCandidates(supabase: SupabaseClient): Promise<MerchantRow[]> {
  const thresholdIso = new Date(Date.now() + REFRESH_WINDOW_MS).toISOString();

  const { data, error } = await supabase
    .from('merchants')
    .select('id, salla_store_id, refresh_token, token_expires_at')
    .not('refresh_token', 'is', null)
    .lt('token_expires_at', thresholdIso);

  if (error) {
    const message =
      (error as { message?: string }).message ?? 'Unknown Supabase error';
    throw new Error(`merchants_query_failed: ${message}`);
  }

  if (!Array.isArray(data)) return [];

  const valid: MerchantRow[] = [];
  for (const row of data) {
    if (isMerchantRow(row)) {
      valid.push(row);
    } else {
      console.warn(
        `[Cron] Skipping malformed merchant row: ${JSON.stringify(row)}`
      );
    }
  }
  return valid;
}

/**
 * يحصي عدد التجار المسجَّلين (refresh_token ليس null) — لاحتساب
 * `not_needed` في الملخص.
 */
async function fetchRegisteredCount(supabase: SupabaseClient): Promise<number> {
  const { count, error } = await supabase
    .from('merchants')
    .select('id', { count: 'exact', head: true })
    .not('refresh_token', 'is', null);

  if (error) {
    const message =
      (error as { message?: string }).message ?? 'Unknown Supabase error';
    console.warn(`[Cron] Could not count registered merchants: ${message}`);
    return 0;
  }
  return typeof count === 'number' ? count : 0;
}

/**
 * يستبدل `refresh_token` بـ access_token جديد عبر نقطة سلة الرسمية.
 */
async function refreshOneToken(
  refreshToken: string
): Promise<RefreshAttemptResult> {
  const creds = readSallaCredentials();
  if (!creds) {
    return { success: false, error: 'missing_salla_credentials' };
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: refreshToken,
  });

  let res: Response;
  try {
    res = await fetch(SALLA_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: `network_exception: ${message}` };
  }

  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    return { success: false, error: `non_json_response_http_${res.status}` };
  }

  if (!res.ok || !isSallaRefreshSuccess(parsed)) {
    const err = parsed as Partial<SallaRefreshErrorPayload> | null;
    const reason = err?.error ?? `http_${res.status}`;
    const desc = err?.error_description ? `: ${err.error_description}` : '';
    return { success: false, error: `salla_error (${reason})${desc}` };
  }

  return { success: true, newTokens: parsed };
}

/**
 * يحدّث صف التاجر بالتوكنات الجديدة.
 * ⚠️ يعيد استخدام نفس منطق `linkTokensToPendingMerchant` (expires_in × 1000).
 */
async function persistNewTokens(
  supabase: SupabaseClient,
  merchantId: string,
  newTokens: SallaRefreshSuccess
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase
    .from('merchants')
    .update({
      access_token: newTokens.access_token,
      refresh_token: newTokens.refresh_token,
      token_expires_at: computeExpiresAtIso(newTokens.expires_in),
    })
    .eq('id', merchantId);

  if (error) {
    const message =
      (error as { message?: string }).message ?? 'Unknown Supabase error';
    return { ok: false, error: message };
  }
  return { ok: true };
}

// ─── Handler ─────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  // (1) المصادقة — Vercel يضيف `Authorization: Bearer ${CRON_SECRET}` تلقائياً.
  const expectedAuth = process.env.CRON_SECRET
    ? `Bearer ${process.env.CRON_SECRET}`
    : null;
  const providedAuth = request.headers.get('authorization');

  if (!expectedAuth || providedAuth !== expectedAuth) {
    console.error('[Cron] ❌ Unauthorized refresh-salla-tokens call');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  console.log('[Cron] 🔄 refresh-salla-tokens started');

  // (2) بناء Supabase Admin Client.
  let supabase: SupabaseClient;
  try {
    supabase = createOrderRoutingSupabaseClient();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Cron] ❌ Supabase client init failed:', message);
    return NextResponse.json(
      { error: 'supabase_init_failed', message },
      { status: 500 }
    );
  }

  // (3) جلب المرشحين + إجمالي المسجَّلين (لاحتساب not_needed).
  let candidates: MerchantRow[];
  let registeredTotal = 0;
  try {
    [candidates, registeredTotal] = await Promise.all([
      fetchCandidates(supabase),
      fetchRegisteredCount(supabase),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Cron] ❌ Query phase failed:', message);
    return NextResponse.json(
      { error: 'query_failed', message },
      { status: 500 }
    );
  }

  console.log(
    `[Cron] 📋 Found ${candidates.length} candidate(s) within ${REFRESH_WINDOW_DAYS}-day window (registered total: ${registeredTotal})`
  );

  // (4) معالجة كل مرشّح — فشل واحد لا يوقف البقية.
  const results: ProcessResult[] = [];
  let updated = 0;
  let failed = 0;

  for (const merchant of candidates) {
    const refresh = await refreshOneToken(merchant.refresh_token);

    if (!refresh.success || !refresh.newTokens) {
      // ⚠️ لا نبتلع الفشل بصمت — invalid_grant/401 تحديداً يعني أن
      //    التاجر يحتاج إعادة تفويض كاملة من صديقك. console.error
      //    يجعل هذا مرئياً فوراً بسجلات Vercel.
      console.error(
        `[Cron] ❌ Refresh failed for merchant ${merchant.id} (salla_store_id=${merchant.salla_store_id}): ${refresh.error}`
      );
      results.push({
        merchantId: merchant.id,
        sallaStoreId: merchant.salla_store_id,
        status: 'failed',
        reason: refresh.error,
      });
      failed++;
      continue;
    }

    const persisted = await persistNewTokens(
      supabase,
      merchant.id,
      refresh.newTokens
    );

    if (!persisted.ok) {
      console.error(
        `[Cron] ❌ DB update failed for merchant ${merchant.id} (salla_store_id=${merchant.salla_store_id}): ${persisted.error}`
      );
      results.push({
        merchantId: merchant.id,
        sallaStoreId: merchant.salla_store_id,
        status: 'failed',
        reason: `db_update_failed: ${persisted.error}`,
      });
      failed++;
      continue;
    }

    console.log(
      `[Cron] ✅ Refreshed merchant ${merchant.id} (salla_store_id=${merchant.salla_store_id}) — new expires_at=${computeExpiresAtIso(refresh.newTokens.expires_in)}`
    );
    results.push({
      merchantId: merchant.id,
      sallaStoreId: merchant.salla_store_id,
      status: 'updated',
    });
    updated++;
  }

  const notNeeded = Math.max(0, registeredTotal - candidates.length);

  const summary = {
    candidates: candidates.length,
    updated,
    failed,
    not_needed: notNeeded,
    results,
  };

  console.log('[Cron] 📊 refresh-salla-tokens summary:', summary);
  return NextResponse.json(summary, { status: 200 });
}
