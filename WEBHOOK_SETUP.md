# Webhook Handler Setup Guide

## Overview
This document explains how to set up and test the Salla webhook handler for order routing automation.

## Endpoints

### 1. Webhook Handler
- **URL**: `POST /api/salla/webhook`
- **Purpose**: Receive `order.created` webhooks from Salla
- **Authentication**: Validates `X-Salla-Signature` header using HMAC SHA256

### 2. Test Endpoint
- **URL**: `GET /api/test/name-extraction`
- **Purpose**: Test name extraction regex patterns
- **Query Parameter**: `?note=بأسم: أحمد محمد`

## Environment Variables

Create a `.env.local` file by copying `.env.local.template` and filling in the values:

```bash
# Salla Integration
SALLA_CLIENT_ID=your_client_id_here
SALLA_CLIENT_SECRET=your_client_secret_here
SALLA_WEBHOOK_SECRET=your_webhook_secret_here

# Supabase
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url_here
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key_here
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key_here
```

## Name Extraction Patterns

The system detects personalization in order notes using these Arabic patterns:

### High Confidence Patterns (with explicit separators)
1. `بأسم: أحمد محمد`
2. `باسم - خالد`
3. `اسم: سارة`
4. `الاسم: عبدالله`
5. `name: John`
6. `باسم العميل: محمد`
7. `اسم العميل - فاطمة`

### Medium Confidence Patterns (without separator)
8. `باسم أحمد`
9. `بأسم أحمد`
10. `اسم خالد`
11. `الاسم عبدالله`

## Testing

### 1. Local Testing
```bash
# Start development server
npm run dev

# Test name extraction with specific note
curl "http://localhost:3000/api/test/name-extraction?note=بأسم: أحمد محمد"

# Test all patterns
curl "http://localhost:3000/api/test/name-extraction?testAll=true"
```

### 2. Webhook Testing with ngrok
```bash
# Install ngrok if not installed
npm install -g ngrok

# Start ngrok tunnel
ngrok http 3000

# Use the https ngrok URL in Salla webhook settings
# URL format: https://abc123.ngrok.io/api/salla/webhook
```

### 3. Manual Webhook Test
```bash
# Generate a test signature (for testing only)
# In production, Salla will send the actual signature

curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-Salla-Signature: your_test_signature" \
  -d '{
    "event": "order.created",
    "data": {
      "id": 12345,
      "items": [
        {
          "id": 1,
          "product_id": 1001,
          "name": "كوب مخصص",
          "note": "بأسم: أحمد محمد"
        }
      ]
    }
  }' \
  http://localhost:3000/api/salla/webhook
```

### 4. Verify Webhook Endpoint
```bash
curl http://localhost:3000/api/salla/webhook
```

## Expected Output

When processing an order with personalization:

```
[Webhook] ✅ Signature verified successfully
[Webhook] 📦 Raw payload received:
{...}
[Webhook] 🛒 Processing Order #12345 with 1 items
[Webhook]   📦 Item: كوب مخصص (ID: 1001)
[Webhook]     📝 Note: "بأسم: أحمد محمد"
[Webhook]     ✅ Personalization detected: "أحمد محمد"
[Webhook]     Pattern: بأسم: pattern (high confidence)
[Webhook]     ⚠️ TODO: Send WhatsApp notification to designer
[Webhook] 📊 Processing Summary: {...}
```

## Next Steps

1. **Database Integration**: Connect to Supabase `product_designer_map` table to lookup designer for each product
2. **WhatsApp Integration**: Implement WhatsApp Cloud API for sending notifications to designers
3. **Logging**: Save results to `order_routing_log` table
4. **Dashboard**: Update `/dashboard/forms` page for managing product-designer mappings

## Security Notes

- Webhook signature verification uses `crypto.timingSafeEqual()` to prevent timing attacks
- All sensitive operations are server-side only
- Never expose `SALLA_CLIENT_SECRET` or `SUPABASE_SERVICE_ROLE_KEY` in client code
- The webhook handler returns HTTP 200 immediately - heavy processing should be done in background

## File Structure

```
app/
├── api/
│   ├── salla/
│   │   └── webhook/
│   │       └── route.ts          # Webhook handler
│   └── test/
│       └── name-extraction/
│           └── route.ts          # Test endpoint
└── lib/
    ├── salla-types.ts            # TypeScript interfaces
    └── name-extractor.ts         # Name extraction logic
```

## Troubleshooting

### Signature Verification Fails
1. Ensure `SALLA_WEBHOOK_SECRET` is correctly set in `.env.local`
2. Check that Salla is sending the signature in `X-Salla-Signature` header
3. Verify the webhook secret matches what you set in Salla dashboard

### No Personalization Detected
1. Check if the note format matches one of the supported patterns
2. Run the test endpoint with the exact note to debug
3. Check server logs for pattern matching details

### Webhook Not Reaching Endpoint
1. Verify the webhook URL is correctly configured in Salla
2. Ensure your server is accessible (use ngrok for local testing)
3. Check Salla webhook delivery logs
