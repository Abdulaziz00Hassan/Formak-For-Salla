"use server";

import { revalidatePath } from "next/cache";

import { createClient as createUserClient } from "@/lib/supabase/server";
import { createOrderRoutingSupabaseClient } from "@/app/lib/order-processor";
import {
  validateDesignerWhatsApp,
  validateSallaProductId,
  isNonEmptyText,
} from "@/app/lib/validators";

export interface ActionResult {
  ok: boolean;
  error: string | null;
}

interface MerchantContext {
  merchantId: string;
  userId: string;
}

async function resolveCurrentMerchantContext(): Promise<MerchantContext | null> {
  const supabase = await createUserClient();
  const { data: claims, error: claimsErr } = await supabase.auth.getClaims();
  if (claimsErr || !claims?.claims) return null;

  const sub = claims.claims.sub;
  if (typeof sub !== "string" || sub.length === 0) return null;
  const userId = sub;

  const { data: merchant, error: mErr } = await supabase
    .from("merchants")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();

  if (mErr) {
    console.error("[mappings] lookup merchant error:", mErr.message);
    return null;
  }
  if (!merchant) return null;

  const id = (merchant as { id: unknown }).id;
  if (typeof id !== "string" || id.length === 0) return null;
  return { merchantId: id, userId };
}

export async function createMappingAction(formData: FormData): Promise<ActionResult> {
  const ctx = await resolveCurrentMerchantContext();
  if (!ctx) {
    return { ok: false, error: "لم يتم العثور على تاجر مرتبط بحسابك." };
  }

  const productLabel = String(formData.get("product_label") ?? "");
  const sallaProductIdRaw = String(formData.get("salla_product_id") ?? "");
  const designerName = String(formData.get("designer_name") ?? "");
  const designerWhatsAppRaw = String(formData.get("designer_whatsapp") ?? "");

  if (!isNonEmptyText(productLabel, 1, 200)) {
    return { ok: false, error: "اسم المنتج مطلوب (حتى 200 حرف)." };
  }
  if (!isNonEmptyText(designerName, 1, 100)) {
    return { ok: false, error: "اسم المصمم مطلوب (حتى 100 حرف)." };
  }

  const productCheck = validateSallaProductId(sallaProductIdRaw);
  if (!productCheck.isValid || productCheck.value === null) {
    return { ok: false, error: productCheck.error ?? "معرّف المنتج غير صالح." };
  }

  const whatsappCheck = validateDesignerWhatsApp(designerWhatsAppRaw);
  if (!whatsappCheck.isValid) {
    return { ok: false, error: whatsappCheck.error ?? "رقم الواتساب غير صالح." };
  }

  const admin = createOrderRoutingSupabaseClient();
  const { error } = await admin.from("product_designer_map").insert({
    merchant_id: ctx.merchantId,
    salla_product_id: productCheck.value,
    product_label: productLabel.trim(),
    designer_name: designerName.trim(),
    designer_whatsapp: whatsappCheck.normalized,
  });

  if (error) {
    console.error("[mappings] insert error:", error.message);
    return { ok: false, error: `فشل الحفظ: ${error.message}` };
  }

  revalidatePath("/dashboard/mappings");
  return { ok: true, error: null };
}

export async function updateMappingAction(
  id: string,
  formData: FormData,
): Promise<ActionResult> {
  const ctx = await resolveCurrentMerchantContext();
  if (!ctx) {
    return { ok: false, error: "لم يتم العثور على تاجر مرتبط بحسابك." };
  }

  const productLabel = String(formData.get("product_label") ?? "");
  const designerName = String(formData.get("designer_name") ?? "");
  const designerWhatsAppRaw = String(formData.get("designer_whatsapp") ?? "");

  if (!isNonEmptyText(productLabel, 1, 200)) {
    return { ok: false, error: "اسم المنتج مطلوب (حتى 200 حرف)." };
  }
  if (!isNonEmptyText(designerName, 1, 100)) {
    return { ok: false, error: "اسم المصمم مطلوب (حتى 100 حرف)." };
  }

  const whatsappCheck = validateDesignerWhatsApp(designerWhatsAppRaw);
  if (!whatsappCheck.isValid) {
    return { ok: false, error: whatsappCheck.error ?? "رقم الواتساب غير صالح." };
  }

  const admin = createOrderRoutingSupabaseClient();
  const { error } = await admin
    .from("product_designer_map")
    .update({
      product_label: productLabel.trim(),
      designer_name: designerName.trim(),
      designer_whatsapp: whatsappCheck.normalized,
    })
    .eq("id", id)
    .eq("merchant_id", ctx.merchantId);

  if (error) {
    console.error("[mappings] update error:", error.message);
    return { ok: false, error: `فشل التحديث: ${error.message}` };
  }

  revalidatePath("/dashboard/mappings");
  return { ok: true, error: null };
}

export async function deleteMappingAction(id: string): Promise<ActionResult> {
  const ctx = await resolveCurrentMerchantContext();
  if (!ctx) {
    return { ok: false, error: "لم يتم العثور على تاجر مرتبط بحسابك." };
  }

  const admin = createOrderRoutingSupabaseClient();
  const { error } = await admin
    .from("product_designer_map")
    .delete()
    .eq("id", id)
    .eq("merchant_id", ctx.merchantId);

  if (error) {
    console.error("[mappings] delete error:", error.message);
    return { ok: false, error: `فشل الحذف: ${error.message}` };
  }

  revalidatePath("/dashboard/mappings");
  return { ok: true, error: null };
}
