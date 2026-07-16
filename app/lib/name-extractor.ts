/**
 * Name Extractor — استخراج اسم التخصيص من ملاحظات الطلب
 *
 * يطبّق مجموعة من أنماط Regex العربية على حقل `note` القادم من سلة
 * لاستخراج اسم العميل عند وجود تخصيص. الأنماط مرتّبة من الأعلى ثقةً إلى
 * الأدنى. الأنماط العالية (مع فاصل صريح مثل ":" أو "-") تُفضَّل على الأنماط
 * المتوسطة (بدون فاصل).
 *
 * مرجع الوثيقة: Formak-Ai-Context-v2.md — القسم 4 (آلية العمل)
 */

import type { ConfidenceLevel, NameExtractionResult } from '@/app/lib/salla-types';

interface ExtractionPattern {
  regex: RegExp;
  description: string;
  confidence: ConfidenceLevel;
}

/**
 * أنماط الاستخراج — مرتّبة بالأولوية.
 *
 * ملاحظة على التصميم:
 *  - نعتمد `(?:^|\n|\s)` قبل الكلمة المفتاحية لتجنّب التطابق داخل كلمات
 *    مركّبة مثل "مكتوب باسم". هذا يحسّن الدقة في النصوص الطويلة.
 *  - نلتقط الاسم حتى نهاية السطر `\n` أو نهاية النص `$`، مع تجنّب الفاصلة
 *    المنقوطة والفاصلة `؛،` لأنها غالباً فواصل بين عدة تخصيصات.
 *  - نقبل كلا الفاصلتين ":" و"：" (النصفية واليونيكود) لتغطية الكتابة العربية.
 */
const extractionPatterns: ExtractionPattern[] = [
  // ─── High confidence — مع كلمة "العميل" الصريحة ───────────────────────
  {
    // ملاحظة: نكتب "بأ?سم" (مع `?` على ا) لتغطية "باسم" و"بأسم" كلاهما.
    // كتابة "بأ?\s*اسم" كانت مغلوطة — تستهلك "ا" ثم تبقى "سم" التي لا تطابق "اسم".
    regex: /(?:^|\n|[\s،,.;؛:!?؟])\s*(?:بأ?سم|باسم)\s*العميل\s*[:：\-]\s*([^\n؛،,]+?)\s*$/imu,
    description: 'باسم العميل:',
    confidence: 'high',
  },
  {
    regex: /(?:^|\n|[\s،,.;؛:!?؟])\s*اسم\s*العميل\s*[:：\-]\s*([^\n؛،,]+?)\s*$/imu,
    description: 'اسم العميل:',
    confidence: 'high',
  },

  // ─── High confidence — مع فاصل صريح ──────────────────────────────────
  {
    regex: /(?:^|\n|[\s،,.;؛:!?؟])\s*بأ?سم\s*[:：\-]\s*([^\n؛،,]+?)\s*$/imu,
    description: 'بأسم:',
    confidence: 'high',
  },
  {
    regex: /(?:^|\n|[\s،,.;؛:!?؟])\s*باسم\s*[:：\-]\s*([^\n؛،,]+?)\s*$/imu,
    description: 'باسم:',
    confidence: 'high',
  },
  {
    regex: /(?:^|\n|[\s،,.;؛:!?؟])\s*الاسم\s*[:：\-]\s*([^\n؛،,]+?)\s*$/imu,
    description: 'الاسم:',
    confidence: 'high',
  },
  {
    regex: /(?:^|\n|[\s،,.;؛:!?؟])\s*اسم\s*[:：\-]\s*([^\n؛،,]+?)\s*$/imu,
    description: 'اسم:',
    confidence: 'high',
  },
  {
    regex: /(?:^|\n|[\s،,.;؛:!?؟])\s*name\s*[:：\-]\s*([^\n؛،,]+?)\s*$/imu,
    description: 'name:',
    confidence: 'high',
  },

  // ─── High confidence — مع فعل "اطبع/اكتب/حفر" + باسم ────────────────
  // ملاحظة: نستخدم (?=\s) بدلاً من \b لأن \b لا يعمل مع الحروف العربية.
  // نقبل أي نص قصير بين الفعل و"باسم" (مثل: "اطبع على الكوب باسم محمد")
  {
    regex: /(?:اطبع|اكتب|اكتبوا|حفر|نقش|نقشوا)(?=\s)[^.\n]{0,40}?\s+(?:بأ?سم|باسم)\s+([^\n؛،,]+?)\s*$/imu,
    description: 'اطبع/اكتب باسم',
    confidence: 'high',
  },
  {
    regex: /(?:اطبع|اكتب|اكتبوا|حفر|نقش|نقشوا)(?=\s)[^.\n]{0,40}?\s+على\s+اسمي?\s+([^\n؛،,]+?)\s*$/imu,
    description: 'اطبع على اسمي',
    confidence: 'high',
  },

  // ─── High confidence — عبارات شائعة في التخصيص ────────────────────────
  {
    regex: /(?:مكتوب|يكتب|يُكتب|اكتب|اطبع)\s+(?:عليه|عليها)\s+اسم\s+([^\n؛،,]+?)\s*$/imu,
    description: 'مكتوب عليه اسم',
    confidence: 'high',
  },
  {
    regex: /التخصيص\s+(?:هو|بـ)\s+([^\n؛،,]+?)\s*$/imu,
    description: 'التخصيص هو/بـ',
    confidence: 'high',
  },

  // ─── Medium confidence — بدون فاصل، الكلمة المفتاحية في البداية ──────
  {
    regex: /^(?:بأ?سم|باسم)\s+([^\n؛،,]+?)\s*$/imu,
    description: 'باسم في البداية',
    confidence: 'medium',
  },
  {
    regex: /^اسم\s+([^\n؛،,]+?)\s*$/imu,
    description: 'اسم في البداية',
    confidence: 'medium',
  },
  {
    regex: /^الاسم\s+([^\n؛،,]+?)\s*$/imu,
    description: 'الاسم في البداية',
    confidence: 'medium',
  },
];

/**
 * قائمة العبارات الممنوعة — إذا كان الاسم المستخرج يحوي عبارة من هذه
 * القائمة، فهو ليس اسماً بل جملة دينية شائعة (مثل: "بسم الله الرحمن").
 * نُسقطه لتجنّب إرسال إشعار خاطئ للمصمم.
 *
 * ملاحظة: "محمد" اسم شائع جداً بين العملاء — لا نُدرجه هنا.
 */
const INVALID_NAME_TOKENS: readonly string[] = [
  'الله',
  'الرحمن',
  'الرحيم',
  'الكريم',
  'العظيم',
  'تبارك',
  'تعالى',
  'سبحان',
];

/**
 * أنماط تنظيف الاسم المستخرج:
 *  - إزالة علامات الترقيم الزائدة في البداية والنهاية.
 *  - إزالة الأقواس والاقتباسات.
 *  - دمج المسافات المتتالية.
 *  - إزالة الكلمات الممنوعة إن كانت هي المكوّن الوحيد.
 */
function cleanExtractedName(raw: string): string {
  const cleaned = raw
    // إزالة المسافات الزائدة في البداية/النهاية
    .trim()
    // إزالة علامات الاقتباس والأقواس في البداية: " ' « » ( [
    .replace(/^["'«»「」()\[\]‹›]+/, '')
    // إزالة علامات الاقتباس والأقواس في النهاية
    .replace(/["'«»「」()\[\]‹›]+$/, '')
    // إزالة الترقيم الشائع في النهاية: ، , . ؛ : ! ؟ -
    .replace(/[،,.;؛:!?؟\-–—]+$/u, '')
    // إزالة الترقيم الشائع في البداية
    .replace(/^[،,.;؛:!?؟\-–—]+/u, '')
    // دمج المسافات المتتالية في مسافة واحدة
    .replace(/\s+/g, ' ')
    // إزالة الأرقام فقط (قد لا يكون اسماً)
    .trim();

  // فلتر الأمان: إذا كان الاسم كلمة ممنوعة فقط، نُسقطه
  if (INVALID_NAME_TOKENS.includes(cleaned)) {
    return '';
  }

  // فلتر الطول: أقل من حرفين غالباً ليس اسماً صحيحاً
  if (cleaned.length < 2) {
    return '';
  }

  // فلتر: يجب أن يحتوي حرفاً عربياً أو لاتينياً واحداً على الأقل
  if (!/[\u0600-\u06FFa-zA-Z]/.test(cleaned)) {
    return '';
  }

  return cleaned;
}

/**
 * الدالة الرئيسية: تستخرج اسم التخصيص من الملاحظة.
 *
 * الخطوات:
 *  1) تنظيف أولي: إزالة الترقيم والاقتباسات من أطراف النص.
 *  2) تجربة كل نمط بالترتيب من الأعلى ثقةً إلى الأدنى.
 *  3) تنظيف الاسم الملتقط وإرجاعه.
 */
export function extractNameFromNote(note: string | null | undefined): NameExtractionResult {
  if (!note || note.trim().length === 0) {
    return {
      extractedName: null,
      patternMatched: null,
      confidence: 'low',
    };
  }

  // تنظيف أولي للنص: إزالة الترقيم الشائع من البداية والنهاية.
  // هذا يساعد على مطابقة "...بأسم: أحمد" أو "...أحمد" (مع كلمة مفتاحية ضمنية).
  const preprocessed = note
    .trim()
    .replace(/^[\s،,.;؛:!?؟\-–—…]+/u, '')
    .replace(/[\s،,.;؛:!?؟\-–—…]+$/u, '');

  for (const pattern of extractionPatterns) {
    const match = preprocessed.match(pattern.regex);
    const captured = match?.[1];

    if (captured === undefined) {
      continue;
    }

    const cleaned = cleanExtractedName(captured);
    if (cleaned.length > 0) {
      return {
        extractedName: cleaned,
        patternMatched: pattern.description,
        confidence: pattern.confidence,
      };
    }
  }

  return {
    extractedName: null,
    patternMatched: null,
    confidence: 'low',
  };
}

/**
 * ملاحظة مساعدة: مسارات الـ log الخاصة بالاختبار المحلي.
 * لا تُستدعى من الـ Webhook handler — فقط من endpoint الاختبار.
 */
export function testNameExtraction(): void {
  const testCases: readonly string[] = [
    'بأسم: أحمد محمد',
    'باسم - خالد',
    'اسم: سارة',
    'الاسم: عبدالله',
    'name: John',
    'باسم العميل: محمد',
    'اسم العميل - فاطمة',
    'باسم أحمد',
    'اسم خالد',
    'الاسم عبدالله',
    'باسم العميل - نورة',
    'ملاحظة: بدون اسم',
    '',
    'أرجو الطباعة باسم: سعيد',
    'طباعة باسم العميل: ريما',
    'اطبع على الكوب باسم محمد',
    'مكتوب عليه اسم فاطمة',
    'بأسم الله', // كلمة ممنوعة
    '...أحمد...', // ترقيم زائد
    '"خالد"', // اقتباس
  ];

  console.log('🧪 Testing name extraction patterns:');
  console.log('====================================');

  testCases.forEach((note, index) => {
    const result = extractNameFromNote(note);
    const statusIcon = result.extractedName ? '✅' : '❌';
    console.log(
      `${statusIcon} Test ${index + 1}: "${note}" → ${result.extractedName ?? 'No match'} (${result.confidence})`
    );
    if (result.patternMatched) {
      console.log(`   Pattern: ${result.patternMatched}`);
    }
  });
}

export function getAllPatternDescriptions(): string[] {
  return extractionPatterns.map((p) => p.description);
}
