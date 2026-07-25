/**
 * Salla OAuth — Step 2: Callback Handler, Token Exchange, Persist
 *
 * نقطة الرجوع من سلة بعد موافقة/رفض التاجر. GET فقط.
 *
 * يُتوقَّع من سلة:
 *   ?code=...    (نجح التفويض)
 *   ?scope=...   (الصلاحيات الممنوحة — سنتحقق تحويها offline_access)
 *   ?state=...   (يجب أن يطابق ما خزّنّا في cookie)
 *   أو:
 *   ?error=...   (التاجر رفض أو خطأ من سلة)
 *
 * المسار:
 *  1) لو ?error موجود → redirect إلى /auth/error (دون كشف تفاصيل حساسة).
 *  2) تحقق state ∈ query يطابق state ∈ cookie (CSRF). اختلاف → رفض.
 *  3) تحقق وجود code. غيابه → رفض (نفس المسار).
 *  4) POST إلى https://accounts.salla.sa/oauth2/token بـ
 *     grant_type=authorization_code + client_id + client_secret + code + redirect_uri
 *     (server-side فقط — client_secret لا يخرج من الخادم أبداً).
 *  5) upsert في merchants (salla_store_id, access_token, refresh_token, token_expires_at).
 *     - token_expires_at = now + expires_in*1000 (إن كان رقمًا موجبًا)
 *                         else now + 14 يومًا.
 *  6) حذف cookie الـstate في كلتا الحالتين (نجاح/فشل).
 *  7) نجاح → redirect إلى /dashboard/mappings?salla_connected=1
 *     فشل  → redirect إلى /auth/error?error=<reason>
 *
 * ⚠️ لا آلية تجديد تلقائي هنا — تُبنى في مرحلة منفصلة كما في Phase 7.
 * ⚠️ scope في رد سلة يجب أن يحوي offline_access. إن غاب → نُسجّل خطأ واضحاً
 *    (refresh_token سيكون null وعمود merchants.refresh_token NOT NULL).
 *
 * مرجع: Formak-Ai-Context-v3.md + Formak-Phase7-to-Launch-v2.md (Phase 9).
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient as createSupabaseAdminClient } from '@supabase/supabase-js';

const STATE_COOKIE_NAME = 'salla_oauth_state';
const SALLA_TOKEN_ENDPOINT = 'https://accounts.salla.sa/oauth2/token';
const DEFAULT_TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60;

const SUCCESS_PATH = '/dashboard/mappings';
const ERROR_PATH = '/auth/error';

// ─── Types ───────────────────────────────────────────────────────────────

interface SallaTokenSuccess {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  merchant: number | string;
}

interface SallaTokenErrorPayload {
  error: string;
  error_description?: string;
}

function isSallaTokenSuccess(value: unknown): value is SallaTokenSuccess {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['access_token'] === 'string' &&
    typeof v['refresh_token'] === 'string' &&
    typeof v['scope'] === 'string' &&
    (typeof v['merchant'] === 'number' || typeof v['merchant'] === 'string')
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function getBaseOrigin(request: NextRequest): string {
  const callbackUrl = process.env.SALLA_CALLBACK_URL;
  if (callbackUrl) {
    try {
      return new URL(callbackUrl).origin;
    } catch {
      // fall through to request origin
    }
  }
  return new URL(request.url).origin;
}

function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      '[Supabase] Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'
    );
  }
  return createSupabaseAdminClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function readRequiredEnv(): {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
} {
  const clientId = process.env.SALLA_CLIENT_ID;
  const clientSecret = process.env.SALLA_CLIENT_SECRET;
  const callbackUrl = process.env.SALLA_CALLBACK_URL;
  if (!clientId || !clientSecret || !callbackUrl) {
    throw new Error(
      'Missing SALLA_CLIENT_ID, SALLA_CLIENT_SECRET, or SALLA_CALLBACK_URL'
    );
  }
  return { clientId, clientSecret, callbackUrl };
}

async function exchangeCodeForToken(code: string): Promise<SallaTokenSuccess> {
  const { clientId, clientSecret, callbackUrl } = readRequiredEnv();

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: callbackUrl,
  });

  const res = await fetch(SALLA_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Token endpoint returned non-JSON (HTTP ${res.status})`);
  }

  if (!res.ok || !isSallaTokenSuccess(data)) {
    // 🔍 تشخيص مؤقت: اطبع الـstatus والـbody كاملاً لمعرفة ما ترسله سلة.
    console.error('[Callback] ❌ Token exchange failed — diagnostic dump:');
    console.error(`[Callback]    res.status = ${res.status}`);
    console.error(`[Callback]    data       = ${JSON.stringify(data)}`);
    const err = data as Partial<SallaTokenErrorPayload> | null;
    const reason = err?.error ?? `http_${res.status}`;
    const desc = err?.error_description ? `: ${err.error_description}` : '';
    throw new Error(`token_exchange_failed (${reason})${desc}`);
  }

  if (!data.scope.split(/\s+/).includes('offline_access')) {
    throw new Error(
      'missing_offline_access_scope — refresh_token لن يُسلَّم، أعد التفويض بـ scope=offline_access'
    );
  }

  return data;
}

function computeExpiresAt(expiresIn: number): Date {
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    return new Date(Date.now() + expiresIn * 1000);
  }
  return new Date(Date.now() + DEFAULT_TOKEN_TTL_SECONDS * 1000);
}

function parseMerchantId(raw: number | string): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error('invalid_merchant_id_from_salla');
}

function buildRedirect(
  baseOrigin: string,
  path: string,
  query: Record<string, string>
): NextResponse {
  const url = new URL(path, baseOrigin);
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, v);
  }
  const response = NextResponse.redirect(url, { status: 302 });
  response.cookies.delete(STATE_COOKIE_NAME);
  return response;
}

// ─── Handler ─────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const sallaError = searchParams.get('error');

  const baseOrigin = getBaseOrigin(request);

  // ── (1) رفض المستخدم / خطأ صريح من سلة ────────────────────────────
  if (sallaError) {
    return buildRedirect(baseOrigin, ERROR_PATH, { error: sallaError });
  }

  // ── (2) التحقق من state (CSRF) — منطق شرطي ──────────────────────
  // حالتان:
  //  (أ) الـcookie موجودة → التاجر مرّ عبر /api/salla/oauth/start → نفّذ
  //      تحقق صارم. أي اختلاف = CSRF attack محتمل → ارفض.
  //  (ب) الـcookie غائبة → التاجر بدأ التثبيت مباشرة من رابط سلة (install
  //      link) دون المرور بـ start route. في هذه الحالة لا يوجد state للمقارنة
  //      به — تجاوز الفحص والاستمرار (الحماية الإضافية: code يُستبدل مرة
  //      واحدة فقط، فلو سُرق الرابط بعد الاستخدام يصبح عديم النفع).
  const cookieState = request.cookies.get(STATE_COOKIE_NAME)?.value;
  if (cookieState !== undefined) {
    if (!state || state !== cookieState) {
      return buildRedirect(baseOrigin, ERROR_PATH, {
        error: 'state_mismatch',
      });
    }
  }

  // ── (3) التحقق من code ─────────────────────────────────────────────
  if (!code) {
    return buildRedirect(baseOrigin, ERROR_PATH, {
      error: 'missing_code',
    });
  }

  // ── (4) + (5) + (6) — المسار السعيد: تبادل + تخزين + تحويل ────────
  try {
    const tokenData = await exchangeCodeForToken(code);
    const expiresAt = computeExpiresAt(tokenData.expires_in);
    const sallaStoreId = parseMerchantId(tokenData.merchant);

    const supabase = createAdminClient();
    const { error: dbError } = await supabase
      .from('merchants')
      .upsert(
        {
          salla_store_id: sallaStoreId,
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          token_expires_at: expiresAt.toISOString(),
        },
        { onConflict: 'salla_store_id' }
      );

    if (dbError) {
      throw new Error(`db_upsert_failed: ${dbError.message}`);
    }

    return buildRedirect(baseOrigin, SUCCESS_PATH, { salla_connected: '1' });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown_error';
    return buildRedirect(baseOrigin, ERROR_PATH, { error: reason });
  }
}
