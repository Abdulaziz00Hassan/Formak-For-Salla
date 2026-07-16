export const WHATSAPP_INTL_REGEX = /^9665\d{8}$/;
export const PRODUCT_ID_REGEX = /^\d{1,19}$/;

export interface WhatsAppValidationResult {
  isValid: boolean;
  normalized: string;
  error: string | null;
}

export function validateDesignerWhatsApp(raw: string): WhatsAppValidationResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { isValid: false, normalized: "", error: "رقم الواتساب مطلوب." };
  }
  if (trimmed.includes("+")) {
    return {
      isValid: false,
      normalized: "",
      error: "لا يُسمح بعلامة +. أدخل الرقم بالصيغة الدولية بدونها.",
    };
  }
  if (/\s/.test(trimmed)) {
    return { isValid: false, normalized: "", error: "الرقم يجب ألا يحتوي فراغات." };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { isValid: false, normalized: "", error: "الرقم يجب أن يحتوي أرقامًا فقط." };
  }
  if (!trimmed.startsWith("966")) {
    return { isValid: false, normalized: "", error: "الرقم يجب أن يبدأ بـ966 (السعودية)." };
  }
  // ⚠️ إصلاح: يجب أن يكون الرقم جوالًا سعوديًا، لا خطًا أرضيًا.
  //    الأرقام الأرضية السعودية دوليةً تبدأ بـ 9661xxxxxxx (الرقم الرابع = 1)
  //    أو 9662xxxxxxx (جدة/مكة/المدينة)، بينما الجوالات تبدأ بـ 9665xxxxxxx.
  //    واتساب يوصل للجوال فقط — لو مرّرنا خطًا أرضيًا، يفشل الإرسال صامتًا.
  //    ملاحظة: تطابق هذا الشرط مع CHECK constraint في ملف supabase-add-format-check.sql.
  if (trimmed.charAt(3) !== "5") {
    return {
      isValid: false,
      normalized: "",
      error:
        "الرقم يجب أن يكون جوالًا سعوديًا (يبدأ بـ9665 — الخطوط الأرضية غير مدعومة في واتساب).",
    };
  }
  if (!WHATSAPP_INTL_REGEX.test(trimmed)) {
    return {
      isValid: false,
      normalized: "",
      error: "الصيغة الصحيحة: 9665 متبوعة بـ8 أرقام (مثال: 966501234567).",
    };
  }
  return { isValid: true, normalized: trimmed, error: null };
}

export interface ProductIdValidationResult {
  isValid: boolean;
  value: number | null;
  error: string | null;
}

export function validateSallaProductId(raw: string): ProductIdValidationResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { isValid: false, value: null, error: "معرّف المنتج بسلة مطلوب." };
  }
  if (!PRODUCT_ID_REGEX.test(trimmed)) {
    return {
      isValid: false,
      value: null,
      error: "المعرّف يجب أن يكون رقمًا صحيحًا موجبًا.",
    };
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n <= 0) {
    return { isValid: false, value: null, error: "المعرّف خارج النطاق المسموح." };
  }
  return { isValid: true, value: n, error: null };
}

export function isNonEmptyText(raw: string, minLength = 1, maxLength = 200): boolean {
  const t = raw.trim();
  return t.length >= minLength && t.length <= maxLength;
}
