/**
 * Test Simulation — اختبار فروع buildTemplateVariables الخمسة
 *
 * سكربت محاكاة محلي مستقل (pure Node، لا يحتاج Next أو أي test framework).
 * يتأكد من 5 فروع مطلوبة للقالب الإنجليزي `order_for_designer`:
 *   1) ملاحظة عادية + تخصيص مكتشف
 *   2) ملاحظة عادية + بلا تخصيص
 *   3) لا ملاحظة (null) + تخصيص (حالة حدية)
 *   4) لا ملاحظة (فارغة "") + بلا تخصيص (الحالة الأكثر شيوعاً)
 *   5) ملاحظة تحوي \n صريحاً + تخصيص (تنظيف \n ودمج المسافات)
 *
 * يُشغَّل بـ:
 *   node --experimental-strip-types scripts/test-template-variables.ts
 *   # أو (Node 24+):
 *   node scripts/test-template-variables.ts
 *
 * ⚠️ هذا السكربت لا يُلمس منطق الإنتاج ولا الـ STUB. للقراءة فقط.
 */

import { writeFileSync } from 'node:fs';

import {
  buildTemplateVariables,
  toMetaTemplateParameters,
  FALLBACK_NO_NOTE_TEXT,
  FALLBACK_NO_PERSONALIZATION_BADGE,
  PERSONALIZATION_DETECTED_BADGE,
  type OrderForDesignerVariables,
  type MetaTemplateBodyParameter,
} from '../app/lib/whatsapp-template-variables.ts';

interface TestExpectation {
  /** القيمة المتوقعة لـ {{1}} orderIdText */
  readonly expectedOrderIdText: string;
  /** القيمة المتوقعة لـ {{2}} productLabelText */
  readonly expectedProductLabelText: string;
  /** القيمة المتوقعة لـ {{3}} noteText */
  readonly expectedNoteText: string;
  /** القيمة المتوقعة لـ {{4}} personalizationBadge */
  readonly expectedPersonalizationBadge: string;
  /** حقول يجب ألّا تحوي \n (افتراضياً كل الحقول، لكن مذكور للتأكيد) */
  readonly mustNotContainNewline: readonly (keyof OrderForDesignerVariables)[];
}

interface TestCase {
  readonly id: number;
  readonly title: string;
  readonly description: string;
  readonly inputs: {
    readonly rawNote: string | null | undefined;
    readonly personalizationDetected: boolean;
    readonly sallaOrderId: number;
    readonly productLabel: string;
  };
  readonly expectations: TestExpectation;
}

// ─── 5 فروع الاختبار — مطابقة لمواصفات النقاط 1 و 6 ──────────────────

const TEST_CASES: readonly TestCase[] = [
  {
    id: 1,
    title: 'الحالة 1: ملاحظة عادية + تخصيص مكتشف',
    description: 'العميل كتب ملاحظة تحوي اسم تخصيص، والـRegex رصد الاسم',
    inputs: {
      rawNote: 'بأسم: خالد',
      personalizationDetected: true,
      sallaOrderId: 12345,
      productLabel: 'كوب مطبوع',
    },
    expectations: {
      expectedOrderIdText: '12345',
      expectedProductLabelText: 'كوب مطبوع',
      expectedNoteText: 'بأسم: خالد',
      expectedPersonalizationBadge: PERSONALIZATION_DETECTED_BADGE,
      mustNotContainNewline: [
        'orderIdText',
        'productLabelText',
        'noteText',
        'personalizationBadge',
      ],
    },
  },
  {
    id: 2,
    title: 'الحالة 2: ملاحظة عادية + لا تخصيص',
    description: 'العميل كتب ملاحظة عامة بلا اسم تخصيص',
    inputs: {
      rawNote: 'التوصيل قبل الساعة ٥ مساءً',
      personalizationDetected: false,
      sallaOrderId: 12346,
      productLabel: 'كوب مطبوع',
    },
    expectations: {
      expectedOrderIdText: '12346',
      expectedProductLabelText: 'كوب مطبوع',
      expectedNoteText: 'التوصيل قبل الساعة ٥ مساءً',
      expectedPersonalizationBadge: FALLBACK_NO_PERSONALIZATION_BADGE,
      mustNotContainNewline: [
        'orderIdText',
        'productLabelText',
        'noteText',
        'personalizationBadge',
      ],
    },
  },
  {
    id: 3,
    title: 'الحالة 3: لا ملاحظة (null) + تخصيص مكتشف (حالة حدية)',
    description:
      'الملاحظة null صراحةً. نختبر أن الدالة لا تكسر حين personalizationDetected=true',
    inputs: {
      rawNote: null,
      personalizationDetected: true,
      sallaOrderId: 12347,
      productLabel: 'كوب مطبوع',
    },
    expectations: {
      expectedOrderIdText: '12347',
      expectedProductLabelText: 'كوب مطبوع',
      expectedNoteText: FALLBACK_NO_NOTE_TEXT,
      expectedPersonalizationBadge: PERSONALIZATION_DETECTED_BADGE,
      mustNotContainNewline: [
        'orderIdText',
        'productLabelText',
        'noteText',
        'personalizationBadge',
      ],
    },
  },
  {
    id: 4,
    title: 'الحالة 4: لا ملاحظة (فارغة "") + لا تخصيص (الحالة الشائعة)',
    description: 'العميل لم يكتب أي ملاحظة إطلاقاً (string فارغ)',
    inputs: {
      rawNote: '',
      personalizationDetected: false,
      sallaOrderId: 12348,
      productLabel: 'كوب مطبوع',
    },
    expectations: {
      expectedOrderIdText: '12348',
      expectedProductLabelText: 'كوب مطبوع',
      expectedNoteText: FALLBACK_NO_NOTE_TEXT,
      expectedPersonalizationBadge: FALLBACK_NO_PERSONALIZATION_BADGE,
      mustNotContainNewline: [
        'orderIdText',
        'productLabelText',
        'noteText',
        'personalizationBadge',
      ],
    },
  },
  {
    id: 5,
    title: 'الحالة 5: ملاحظة تحوي \\n صريحاً + تخصيص (التنظيف التلقائي)',
    description:
      'العميل كتب ملاحظة متعددة الأسطر — يجب أن يحذف \\n ويستبدلها بمسافة، ويدمج أي مسافات متتالية',
    inputs: {
      rawNote: 'بأسم: خالد\nملاحظة إضافية   بمسافات   زائدة',
      personalizationDetected: true,
      sallaOrderId: 12349,
      productLabel: 'كوب مطبوع',
    },
    expectations: {
      // بعد التنظيف: "بأسم: خالد ملاحظة إضافية بمسافات زائدة"
      expectedOrderIdText: '12349',
      expectedProductLabelText: 'كوب مطبوع',
      expectedNoteText: 'بأسم: خالد ملاحظة إضافية بمسافات زائدة',
      expectedPersonalizationBadge: PERSONALIZATION_DETECTED_BADGE,
      mustNotContainNewline: [
        'orderIdText',
        'productLabelText',
        'noteText',
        'personalizationBadge',
      ],
    },
  },
];

// ─── Helpers — عرض وتحقق ───────────────────────────────────────────────

function renderVariables(v: OrderForDesignerVariables): string {
  return [
    `{{1}} orderIdText          = ${JSON.stringify(v.orderIdText)}`,
    `{{2}} productLabelText     = ${JSON.stringify(v.productLabelText)}`,
    `{{3}} noteText             = ${JSON.stringify(v.noteText)}`,
    `{{4}} personalizationBadge = ${JSON.stringify(v.personalizationBadge)}`,
  ].join('\n     ');
}

function renderMetaJson(params: readonly MetaTemplateBodyParameter[]): string {
  return JSON.stringify(params, null, 2);
}

interface CheckResult {
  readonly passed: boolean;
  readonly details: readonly string[];
}

function checkCase(tc: TestCase, actual: OrderForDesignerVariables): CheckResult {
  const details: string[] = [];

  // 1) تطابق {{1}} orderIdText
  const orderIdMatches = actual.orderIdText === tc.expectations.expectedOrderIdText;
  details.push(
    `  • {{1}} orderIdText متطابق مع المتوقع: ${orderIdMatches ? '✅' : '❌'} ` +
      `(متوقع: ${JSON.stringify(tc.expectations.expectedOrderIdText)}, ` +
      `فعلي: ${JSON.stringify(actual.orderIdText)})`
  );

  // 2) تطابق {{2}} productLabelText
  const productMatches =
    actual.productLabelText === tc.expectations.expectedProductLabelText;
  details.push(
    `  • {{2}} productLabelText متطابق مع المتوقع: ${productMatches ? '✅' : '❌'} ` +
      `(متوقع: ${JSON.stringify(tc.expectations.expectedProductLabelText)}, ` +
      `فعلي: ${JSON.stringify(actual.productLabelText)})`
  );

  // 3) تطابق {{3}} noteText
  const noteMatches = actual.noteText === tc.expectations.expectedNoteText;
  details.push(
    `  • {{3}} noteText متطابق مع المتوقع: ${noteMatches ? '✅' : '❌'} ` +
      `(متوقع: ${JSON.stringify(tc.expectations.expectedNoteText)}, ` +
      `فعلي: ${JSON.stringify(actual.noteText)})`
  );

  // 4) تطابق {{4}} personalizationBadge
  const badgeMatches =
    actual.personalizationBadge === tc.expectations.expectedPersonalizationBadge;
  details.push(
    `  • {{4}} personalizationBadge متطابق مع المتوقع: ${badgeMatches ? '✅' : '❌'} ` +
      `(متوقع: ${JSON.stringify(tc.expectations.expectedPersonalizationBadge)}, ` +
      `فعلي: ${JSON.stringify(actual.personalizationBadge)})`
  );

  // 5) لا \n في الحقول المطلوبة (مهم للحالة 5)
  const newlineFields: string[] = [];
  for (const field of tc.expectations.mustNotContainNewline) {
    const value = actual[field] as string;
    if (value.includes('\n')) {
      newlineFields.push(field);
    }
  }
  const noNewlines = newlineFields.length === 0;
  details.push(
    `  • لا يحوي \\n في الحقول المطلوبة: ${noNewlines ? '✅' : '❌'} ` +
      (noNewlines ? '' : `(اكتُشف \\n في: ${newlineFields.join(', ')})`)
  );

  // 6) لا قيم 'undefined' أو 'null' أو '[object Object]' داخل النصوص
  const forbiddenTokens = ['undefined', 'null', '[object Object]'];
  const stringFields: readonly (keyof OrderForDesignerVariables)[] = [
    'orderIdText',
    'productLabelText',
    'noteText',
    'personalizationBadge',
  ];
  const fieldsWithForbidden: string[] = [];
  for (const field of stringFields) {
    const value = actual[field] as string;
    for (const token of forbiddenTokens) {
      if (value.includes(token)) {
        fieldsWithForbidden.push(`${field}(${token})`);
      }
    }
  }
  const noForbidden = fieldsWithForbidden.length === 0;
  details.push(
    `  • لا يحتوي undefined/null/[object Object]: ${noForbidden ? '✅' : '❌'} ` +
      (noForbidden ? '' : `(مُكتشف في: ${fieldsWithForbidden.join(', ')})`)
  );

  // 7) {{1}} لا يحوي # مكررة (النص الثابت يحوي # قبله)
  const orderIdHasHash = actual.orderIdText.includes('#');
  details.push(
    `  • {{1}} orderIdText بلا # (لأن النص الثابت يحويها): ${!orderIdHasHash ? '✅' : '❌'} ` +
      (orderIdHasHash ? `(وُجد # في: ${JSON.stringify(actual.orderIdText)})` : '')
  );

  // 8) {{2}} لا يحوي "for" (النص الثابت يحوي "for" قبله)
  const productHasFor = /\bfor\b/i.test(actual.productLabelText);
  details.push(
    `  • {{2}} productLabelText بلا "for" (لأن النص الثابت يحويها): ${!productHasFor ? '✅' : '❌'} ` +
      (productHasFor ? `(وُجدت "for" في: ${JSON.stringify(actual.productLabelText)})` : '')
  );

  return {
    passed:
      orderIdMatches &&
      productMatches &&
      noteMatches &&
      badgeMatches &&
      noNewlines &&
      noForbidden &&
      !orderIdHasHash &&
      !productHasFor,
    details,
  };
}

// ─── Main — التشغيل الرئيسي ────────────────────────────────────────────

function main(): void {
  const fileOut: string[] = [];
  const W = 70;
  const sep = '='.repeat(W);
  const rule = '-'.repeat(W);

  fileOut.push('🧪 اختبار دالة buildTemplateVariables — 5 فروع (القالب الإنجليزي)');
  fileOut.push(sep);
  fileOut.push('');

  console.log('🧪 اختبار دالة buildTemplateVariables — 5 فروع (القالب الإنجليزي)\n');
  console.log(sep);

  let passed = 0;
  let failed = 0;

  for (const tc of TEST_CASES) {
    console.log(`\n📋 ${tc.title}`);
    console.log(`   ${tc.description}`);
    console.log(rule);

    fileOut.push(`📋 ${tc.title}`);
    fileOut.push(`   ${tc.description}`);
    fileOut.push(rule);

    // 1) المدخلات
    const inputsBlock = [
      '   المدخلات:',
      `     rawNote                 = ${JSON.stringify(tc.inputs.rawNote)}`,
      `     personalizationDetected = ${tc.inputs.personalizationDetected}`,
      `     sallaOrderId            = ${tc.inputs.sallaOrderId}`,
      `     productLabel            = ${JSON.stringify(tc.inputs.productLabel)}`,
    ];
    console.log(inputsBlock.join('\n'));
    fileOut.push(...inputsBlock);

    // 2) تشغيل الدالة
    const result = buildTemplateVariables(
      tc.inputs.rawNote,
      tc.inputs.personalizationDetected,
      tc.inputs.sallaOrderId,
      tc.inputs.productLabel
    );

    // 3) المخرجات
    const varsBlock = [
      '',
      '   المخرجات (OrderForDesignerVariables):',
      '     ' + renderVariables(result).split('\n').join('\n     '),
    ];
    console.log(varsBlock.join('\n'));
    fileOut.push(...varsBlock);

    // 4) JSON لـ Meta API
    const metaParams = toMetaTemplateParameters(result);
    const metaBlock = [
      '',
      '   Meta API body parameters (JSON):',
      renderMetaJson(metaParams)
        .split('\n')
        .map((line) => '     ' + line)
        .join('\n'),
    ];
    console.log(metaBlock.join('\n'));
    fileOut.push(...metaBlock);

    // 5) الفحوصات
    const check = checkCase(tc, result);
    const checksBlock = ['', '   الفحوصات:', ...check.details];
    console.log(checksBlock.join('\n'));
    fileOut.push(...checksBlock);

    const status = check.passed ? '✅ نجح' : '❌ فشل';
    const statusLine = `\n   🏁 نتيجة الحالة ${tc.id}: ${status}`;
    console.log(statusLine);
    fileOut.push(statusLine);

    if (check.passed) {
      passed++;
    } else {
      failed++;
    }
  }

  // ─── ملخص نهائي ─────────────────────────────────────────────
  const summary = [
    '',
    sep,
    `📊 ملخص: ${passed} نجح / ${failed} فشل من أصل ${TEST_CASES.length} حالات`,
    sep,
    '',
    failed > 0
      ? '❌ الاختبار فشل في حالة واحدة أو أكثر.'
      : '✅ كل الحالات الـ5 نجحت. الدالة جاهزة للاستخدام في المرحلة 8-ج.',
  ];

  console.log('\n' + summary.slice(1).join('\n'));
  fileOut.push(...summary);

  // كتابة ملف UTF-8 نظيف للمراجعة (PowerShell pipeline يكسر العربية)
  try {
    writeFileSync('scripts/test-output.txt', fileOut.join('\n') + '\n', 'utf8');
    console.log('\n📄 نُسخ الناتج النظيف إلى scripts/test-output.txt (UTF-8).');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`\n⚠️ تعذّر كتابة scripts/test-output.txt: ${msg}`);
  }

  if (failed > 0) {
    process.exit(1);
  }
}

main();
