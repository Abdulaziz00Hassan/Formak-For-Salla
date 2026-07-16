/**
 * RLS Isolation Test — إثبات أن سياسات RLS تحمي جدول product_designer_map
 *
 * الهدف: التأكد أن مستخدم مسجّل دخوله كـ"التاجر A" لا يستطيع قراءة أو
 * تعديل أو حذف أي صف يخص "التاجر B" في جدول product_designer_map
 * — حتى لو كان يستعلم مباشرة بـ Supabase Client + Anon Key (أي
 * تجاوز كامل لـ Server Actions، تماماً كما يفعل مهاجم خبيث أو عميل
 * معدّل في DevTools).
 *
 * يُشغَّل بـ:
 *   node --experimental-strip-types scripts/test-rls-isolation.ts
 *
 * التدفّق:
 *  1) تهيئة: إنشاء مستخدمَين وهميَّين A و B عبر Service Role (يتجاوز RLS)
 *  2) ربط كل مستخدم بـ merchant خاص به
 *  3) إدراج صف product_designer_map لكل تاجر
 *  4) اختبار العزل: التوقيع دخول A و B بالـ Anon Key ومحاولة كل عملية
 *  5) تنظيف: حذف كل البيانات الوهمية
 *
 *  ⚠️ السكربت يستخدم Service Role في التهيئة/التنظيف فقط (لا يلعب دور
 *     المهاجم). كل اختبارات العزل الفعلية تتم عبر Anon Key + JWT مستخدم.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ─── تحميل متغيرات البيئة (.env.local) عبر علم Node المدمج ────────────
//   يُشغَّل السكربت بـ: node --env-file=.env.local --experimental-strip-types scripts/test-rls-isolation.ts
//   --env-file متاح رسمياً في Node 20.6+ (v24 مؤكد).
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
  console.error('❌ متغيرات Supabase ناقصة في .env.local');
  process.exit(1);
}

// ─── ثوابت ──────────────────────────────────────────────────────────────
const STAMP = Date.now();
const PASSWORD = 'Test-Strong-Pwd-2026!';
const USER_A = {
  email: `rls-test-a-${STAMP}@formak-test.local`,
  password: PASSWORD,
  label: 'تاجر-A',
};
const USER_B = {
  email: `rls-test-b-${STAMP}@formak-test.local`,
  password: PASSWORD,
  label: 'تاجر-B',
};

const W = 78;
const sep = '='.repeat(W);
const rule = '-'.repeat(W);

// ─── أدوات مساعدة ───────────────────────────────────────────────────────
function logStep(msg: string): void {
  console.log(`\n${rule}\n🔹 ${msg}\n${rule}`);
}

function pass(msg: string): void {
  console.log(`   ✅ ${msg}`);
}

function fail(msg: string): void {
  console.log(`   ❌ ${msg}`);
}

function info(msg: string): void {
  console.log(`   ℹ️  ${msg}`);
}

interface TestCase {
  name: string;
  ok: boolean;
  detail: string;
}

const results: { passed: number; failed: number; cases: TestCase[] } = {
  passed: 0,
  failed: 0,
  cases: [],
};

function record(name: string, ok: boolean, detail: string): void {
  const tc: TestCase = { name, ok, detail };
  results.cases.push(tc);
  if (ok) {
    results.passed++;
    pass(`${name} — ${detail}`);
  } else {
    results.failed++;
    fail(`${name} — ${detail}`);
  }
}

// ─── البرنامج الرئيسي ──────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(sep);
  console.log('🛡️  RLS Isolation Test — product_designer_map');
  console.log(sep);
  console.log(`URL:    ${SUPABASE_URL}`);
  console.log(`Anon:   ${ANON_KEY!.slice(0, 16)}…`);
  console.log(`Admin:  ${SERVICE_ROLE_KEY!.slice(0, 16)}…`);

  // ─── 1) فحص أولي: Service Role يتجاوز RLS دائماً ──────────────────
  logStep('1) فحص أولي — Service Role يتجاوز RLS (sanity check)');

  const admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { error: rlsErr } = await admin
    .from('product_designer_map')
    .select('id', { count: 'exact', head: true });

  if (rlsErr) {
    fail(`فشل فحص أولي (Service Role): ${rlsErr.message}`);
    process.exit(1);
  }
  pass('الاتصال بـ Supabase نجح (Service Role يتجاوز RLS كما هو متوقع).');
  info(
    'ملاحظة: التحقق من تفعيل RLS نفسه يتم لاحقاً من خلال فشل محاولات العزل — إذا نجح A في رؤية/تعديل صف B فهذا يعني RLS غير مفعّل.'
  );

  // ─── 2) إنشاء مستخدمَين وهميَّين عبر Service Role ───────────────
  logStep('2) إنشاء تاجرَين وهميَّين A و B (Service Role)');

  let userA: { id: string };
  let userB: { id: string };
  try {
    const a = await admin.auth.admin.createUser({
      email: USER_A.email,
      password: USER_A.password,
      email_confirm: true,
      user_metadata: { role: 'test_merchant_a' },
    });
    if (a.error || !a.data.user) {
      throw new Error(`فشل إنشاء A: ${a.error?.message ?? 'no user'}`);
    }
    userA = { id: a.data.user.id };
    pass(`أُنشئ ${USER_A.label} → user_id=${userA.id.slice(0, 8)}…`);

    const b = await admin.auth.admin.createUser({
      email: USER_B.email,
      password: USER_B.password,
      email_confirm: true,
      user_metadata: { role: 'test_merchant_b' },
    });
    if (b.error || !b.data.user) {
      throw new Error(`فشل إنشاء B: ${b.error?.message ?? 'no user'}`);
    }
    userB = { id: b.data.user.id };
    pass(`أُنشئ ${USER_B.label} → user_id=${userB.id.slice(0, 8)}…`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fail(`فشل إنشاء المستخدمين: ${msg}`);
    process.exit(1);
  }

  // ─── 3) إنشاء صفّين في merchants (A و B) ──────────────────────────
  logStep('3) إنشاء merchant مرتبط بكل مستخدم');

  const { data: mA, error: mAErr } = await admin
    .from('merchants')
    .insert({
      salla_store_id: 9_000_000 + STAMP % 1_000_000,
      access_token: 'test-token-A',
      refresh_token: 'test-refresh-A',
      token_expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      user_id: userA.id,
    })
    .select('id')
    .single();
  if (mAErr || !mA) {
    fail(`فشل إنشاء merchant لـ A: ${mAErr?.message ?? 'no row'}`);
    await cleanup(admin, undefined, [userA.id, userB.id]);
    process.exit(1);
  }
  const merchantAId = (mA as { id: string }).id;
  pass(`merchantA id=${merchantAId.slice(0, 8)}… (مرتبط بـ userA)`);

  const { data: mB, error: mBErr } = await admin
    .from('merchants')
    .insert({
      salla_store_id: 8_000_000 + STAMP % 1_000_000,
      access_token: 'test-token-B',
      refresh_token: 'test-refresh-B',
      token_expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      user_id: userB.id,
    })
    .select('id')
    .single();
  if (mBErr || !mB) {
    fail(`فشل إنشاء merchant لـ B: ${mBErr?.message ?? 'no row'}`);
    await cleanup(admin, [merchantAId], [userA.id, userB.id]);
    process.exit(1);
  }
  const merchantBId = (mB as { id: string }).id;
  pass(`merchantB id=${merchantBId.slice(0, 8)}… (مرتبط بـ userB)`);

  // ─── 4) إنشاء صفّين في product_designer_map ──────────────────────
  logStep('4) إنشاء تعيينَين وهميَّين (صف لكل تاجر)');

  const productIdA = 70_000_000 + (STAMP % 1_000_000);
  const productIdB = 60_000_000 + (STAMP % 1_000_000);

  const { data: pA, error: pAErr } = await admin
    .from('product_designer_map')
    .insert({
      merchant_id: merchantAId,
      salla_product_id: productIdA,
      product_label: 'منتج اختبار A',
      designer_name: 'مصمم A',
      designer_whatsapp: '966501111111',
    })
    .select('id')
    .single();
  if (pAErr || !pA) {
    fail(`فشل إدراج صف A: ${pAErr?.message ?? 'no row'}`);
    await cleanup(admin, [merchantAId, merchantBId], [userA.id, userB.id]);
    process.exit(1);
  }
  const rowAId = (pA as { id: string }).id;
  pass(`صفّ A أُدرج (id=${rowAId.slice(0, 8)}…, salla_product_id=${productIdA})`);

  const { data: pB, error: pBErr } = await admin
    .from('product_designer_map')
    .insert({
      merchant_id: merchantBId,
      salla_product_id: productIdB,
      product_label: 'منتج اختبار B',
      designer_name: 'مصمم B',
      designer_whatsapp: '966502222222',
    })
    .select('id')
    .single();
  if (pBErr || !pB) {
    fail(`فشل إدراج صف B: ${pBErr?.message ?? 'no row'}`);
    await cleanup(admin, [merchantAId, merchantBId], [userA.id, userB.id]);
    process.exit(1);
  }
  const rowBId = (pB as { id: string }).id;
  pass(`صفّ B أُدرج (id=${rowBId.slice(0, 8)}…, salla_product_id=${productIdB})`);

  // ─── 5) تسجيل دخول A و B عبر Anon Key + JWT ─────────────────────
  logStep('5) تسجيل دخول التاجرَين عبر Anon Key (هجوم خبيث محاكى)');

  const anonA: SupabaseClient = createClient(SUPABASE_URL!, ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const anonB: SupabaseClient = createClient(SUPABASE_URL!, ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const signInA = await anonA.auth.signInWithPassword({
    email: USER_A.email,
    password: USER_A.password,
  });
  if (signInA.error || !signInA.data.session) {
    fail(`فشل تسجيل دخول A: ${signInA.error?.message ?? 'no session'}`);
    await cleanup(admin, [merchantAId, merchantBId], [userA.id, userB.id]);
    process.exit(1);
  }
  pass(`A سجّل دخوله (JWT صادر بنجاح، طول=${signInA.data.session.access_token.length})`);

  const signInB = await anonB.auth.signInWithPassword({
    email: USER_B.email,
    password: USER_B.password,
  });
  if (signInB.error || !signInB.data.session) {
    fail(`فشل تسجيل دخول B: ${signInB.error?.message ?? 'no session'}`);
    await cleanup(admin, [merchantAId, merchantBId], [userA.id, userB.id]);
    process.exit(1);
  }
  pass(`B سجّل دخوله (JWT صادر بنجاح، طول=${signInB.data.session.access_token.length})`);

  // ─── 6) اختبارات العزل الفعلية ───────────────────────────────────
  logStep('6) اختبارات العزل — 6 محاولات اختراق');

  // 6.1) A يقرأ كل الصفوف — يجب أن يرى صفّه فقط (لا صف B)
  {
    const { data, error } = await anonA
      .from('product_designer_map')
      .select('id,merchant_id,salla_product_id,product_label');
    if (error) {
      record(
        'A: SELECT * (يجب أن ينجح)',
        false,
        `خطأ API: ${error.message}`
      );
    } else {
      const rows = (data ?? []) as Array<{ id: string; merchant_id: string }>;
      const sawOwn = rows.some((r) => r.id === rowAId);
      const sawForeign = rows.some((r) => r.id === rowBId);
      record(
        'A: SELECT * — يرى صفّه فقط',
        sawOwn && !sawForeign && rows.length >= 1,
        `رأى ${rows.length} صف(وف): own=${sawOwn} foreign(B)=${sawForeign} (المتوقع: own=true, foreign=false)`
      );
    }
  }

  // 6.2) A يحاول جلب صف B بمعرّفه الصريح — يجب أن يُرجِع null/false
  {
    const { data, error } = await anonA
      .from('product_designer_map')
      .select('id,merchant_id,product_label')
      .eq('id', rowBId)
      .maybeSingle();
    const sawRow = !!data;
    record(
      'A: SELECT WHERE id = row_B.id — يجب أن يفشل',
      !sawRow,
      `رأى صف B؟ ${sawRow} (المتوقع: false) ${error ? `| err=${error.message}` : ''}`
    );
  }

  // 6.3) A يحاول إدراج صف بـ merchant_id = merchantBId (هجوم impersonation)
  {
    const { data, error } = await anonA
      .from('product_designer_map')
      .insert({
        merchant_id: merchantBId,
        salla_product_id: 50_000_000 + (STAMP % 1_000_000),
        product_label: 'محاولة اختراق A→B',
        designer_name: 'مُهاجم',
        designer_whatsapp: '966509999999',
      })
      .select('id');
    const insertedRows = (data ?? []) as unknown[];
    record(
      'A: INSERT بـ merchant_id = merchantBId — يجب أن يُرفض',
      insertedRows.length === 0,
      `أُدرجت ${insertedRows.length} صفوف | err=${error?.message ?? 'none'} (المتوقع: 0 + رسالة RLS)`
    );
  }

  // 6.4) A يحاول UPDATE صف B — يجب أن يُؤثّر على 0 صفوف
  {
    const { data, error } = await anonA
      .from('product_designer_map')
      .update({ product_label: 'A_هاجم_B_لكن_فشل' })
      .eq('id', rowBId)
      .select('id');
    const updatedRows = (data ?? []) as unknown[];
    record(
      'A: UPDATE صف B — يجب ألّا يُعدّل شيئاً',
      updatedRows.length === 0,
      `عدّل ${updatedRows.length} صفوف | err=${error?.message ?? 'none'} (المتوقع: 0)`
    );
  }

  // 6.5) A يحاول DELETE صف B — يجب ألّا يحذف شيئاً
  {
    const { data, error } = await anonA
      .from('product_designer_map')
      .delete()
      .eq('id', rowBId)
      .select('id');
    const deletedRows = (data ?? []) as unknown[];
    record(
      'A: DELETE صف B — يجب ألّا يحذف شيئاً',
      deletedRows.length === 0,
      `حذف ${deletedRows.length} صفوف | err=${error?.message ?? 'none'} (المتوقع: 0)`
    );
  }

  // 6.6) B يقرأ كل الصفوف — يجب أن يرى صفّه فقط (لا صف A)
  {
    const { data, error } = await anonB
      .from('product_designer_map')
      .select('id,merchant_id,salla_product_id,product_label');
    if (error) {
      record(
        'B: SELECT * (يجب أن ينجح)',
        false,
        `خطأ API: ${error.message}`
      );
    } else {
      const rows = (data ?? []) as Array<{ id: string; merchant_id: string }>;
      const sawOwn = rows.some((r) => r.id === rowBId);
      const sawForeign = rows.some((r) => r.id === rowAId);
      record(
        'B: SELECT * — يرى صفّه فقط',
        sawOwn && !sawForeign && rows.length >= 1,
        `رأى ${rows.length} صف(وف): own=${sawOwn} foreign(A)=${sawForeign} (المتوقع: own=true, foreign=false)`
      );
    }
  }

  // 6.7) B يحاول UPDATE صف A — يجب ألّا يُعدّل شيئاً
  {
    const { data, error } = await anonB
      .from('product_designer_map')
      .update({ product_label: 'B_هاجم_A_لكن_فشل' })
      .eq('id', rowAId)
      .select('id');
    const updatedRows = (data ?? []) as unknown[];
    record(
      'B: UPDATE صف A — يجب ألّا يُعدّل شيئاً',
      updatedRows.length === 0,
      `عدّل ${updatedRows.length} صفوف | err=${error?.message ?? 'none'} (المتوقع: 0)`
    );
  }

  // ─── 7) فحص السلامة بعد المحاولات: لا تغيير فعلي في قاعدة البيانات ─
  logStep('7) فحص ما بعد الهجوم — هل تغيّرت بيانات B؟');

  const { data: verifyB, error: vBErr } = await admin
    .from('product_designer_map')
    .select('id,product_label,designer_name')
    .eq('id', rowBId)
    .single();
  const verifiedB = verifyB as { product_label: string; designer_name: string } | null;
  record(
    'صفّ B لم يتغيّر بعد كل المحاولات',
    !vBErr && verifiedB?.product_label === 'منتج اختبار B',
    `label الفعلي = ${JSON.stringify(verifiedB?.product_label)} (المتوقع: "منتج اختبار B")`
  );

  // ─── تنظيف ────────────────────────────────────────────────────────
  logStep('8) تنظيف كل البيانات الوهمية');
  await cleanup(admin, [merchantAId, merchantBId], [userA.id, userB.id]);
  pass('تم حذف كل صفوف الاختبار + المستخدمَين الوهميَّين.');

  // ─── ملخص نهائي ──────────────────────────────────────────────────
  console.log('\n' + sep);
  console.log('📊 ملخص نتائج RLS Isolation Test:');
  console.log(sep);
  for (const tc of results.cases) {
    const sym = tc.ok ? '✅' : '❌';
    console.log(`  ${sym} ${tc.name}`);
  }
  console.log(rule);
  console.log(`  نجح: ${results.passed} | فشل: ${results.failed} | الإجمالي: ${results.cases.length}`);
  console.log(sep);

  if (results.failed > 0) {
    console.log('\n❌ FAIL — RLS لا يعزل التاجرَين بالشكل المطلوب.');
    process.exit(1);
  } else {
    console.log('\n✅ PASS — RLS يعزل التاجرَين بشكل صحيح على جدول product_designer_map.');
    process.exit(0);
  }
}

// ─── دالة التنظيف (تعمل مع Service Role) ──────────────────────────────
async function cleanup(
  admin: SupabaseClient,
  merchantIds: string[] | undefined,
  userIds: string[]
): Promise<void> {
  try {
    if (merchantIds && merchantIds.length > 0) {
      // حذف الـ merchants سيحذف product_designer_map بـ ON DELETE CASCADE
      const { error } = await admin
        .from('merchants')
        .delete()
        .in('id', merchantIds);
      if (error) {
        console.warn(`   ⚠️ تعذّر حذف merchants: ${error.message}`);
      }
    }
    for (const uid of userIds) {
      const { error } = await admin.auth.admin.deleteUser(uid);
      if (error) {
        console.warn(`   ⚠️ تعذّر حذف المستخدم ${uid.slice(0, 8)}…: ${error.message}`);
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`   ⚠️ استثناء أثناء التنظيف: ${msg}`);
  }
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`\n❌ استثناء غير متوقَّع: ${msg}`);
  process.exit(1);
});
