#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# اختبار مباشر لـ order.created — يتجاوز سلة كليًا (Formak-Handoff-3 §4، نقطة 1)
# الهدف: فصل "هل كودك يتحقق من HMAC ويعالج الحمولة صح؟"
#        عن "لماذا سلة لا ترسل order.created لطلبات لوحة test_01 اليدوية؟"
#
# شغّله محليًا فقط. لا تكتب/تلصق SALLA_WEBHOOK_SECRET في أي محادثة AI.
# ============================================================================

: "${SALLA_WEBHOOK_SECRET:?عيّن السر أولاً بهذه الجلسة الطرفية:
  export SALLA_WEBHOOK_SECRET=\"نفس القيمة من .env.local / Vercel\"}"

# ---------- عدّل هذه القيم قبل التشغيل ----------
MERCHANT_STORE_ID=244457341     # store_id الحقيقي (test_01) — مؤكَّد بقاعدتك، Handoff-3 §1
PRODUCT_ID="274747734"         # شغّل SQL بالأسفل، ضع salla_product_id حقيقيًا من product_designer_map
NOTE_TEXT="بأسم خالد الاختباري"  # يطابق عمدًا نمط الـregex: بأسم|باسم|اسم[:\-]
# --------------------------------------------------

if [[ "$PRODUCT_ID" == "REPLACE_ME" ]]; then
  echo "عدّل PRODUCT_ID داخل الملف أولاً (استعلام SQL في تعليقات آخر الملف)." >&2
  exit 1
fi

WEBHOOK_URL="https://formak-tau.vercel.app/api/salla/webhook"
ORDER_ID=900000007
CREATED_AT="$(date -u '+%Y-%m-%d %H:%M:%S')"
PAYLOAD_FILE="formak-order-created-test.json"

cat > "$PAYLOAD_FILE" <<EOF
{
  "event": "order.created",
  "merchant": ${MERCHANT_STORE_ID},
  "created_at": "${CREATED_AT}",
  "data": {
    "id": ${ORDER_ID},
    "reference_id": ${ORDER_ID},
    "status": { "id": 566146469, "name": "بإنتظار المراجعة", "slug": "under_review" },
    "payment_method": "bank",
    "currency": "SAR",
    "customer": {
      "id": 1000000001,
      "first_name": "عميل",
      "last_name": "اختباري",
      "mobile": 500000000,
      "mobile_code": "+966",
      "email": "test@example.com"
    },
    "items": [
      {
        "id": 800000001,
        "name": "منتج اختبار",
        "sku": "TEST-SKU",
        "quantity": 1,
        "currency": "SAR",
        "notes": "${NOTE_TEXT}",
        "product": {
          "id": ${PRODUCT_ID},
          "type": "product",
          "sku": "TEST-SKU",
          "name": "منتج اختبار"
        },
        "options": [],
        "images": [],
        "codes": [],
        "files": []
      }
    ],
    "bank": null,
    "tags": []
  }
}
EOF

SIGNATURE=$(node -e '
  const crypto = require("crypto");
  const fs = require("fs");
  const body = fs.readFileSync(process.argv[1]);
  process.stdout.write(crypto.createHmac("sha256", process.env.SALLA_WEBHOOK_SECRET).update(body).digest("hex"));
' "$PAYLOAD_FILE")

echo "الحمولة: $PAYLOAD_FILE"
echo "التوقيع (X-Salla-Signature): $SIGNATURE"
echo "---"

curl -i -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -H "X-Salla-Security-Strategy: Signature" \
  -H "X-Salla-Signature: ${SIGNATURE}" \
  --data-binary @"$PAYLOAD_FILE"

echo
echo "---"
echo "الملف لم يُحذف: $PAYLOAD_FILE"
