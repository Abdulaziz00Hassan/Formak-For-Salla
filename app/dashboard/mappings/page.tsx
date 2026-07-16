import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus } from "lucide-react";

import { MappingsTable, type MappingRow } from "./mappings-table";
import { MappingDialog } from "./mapping-dialog";

interface MerchantRow {
  id: string;
  salla_store_id: number;
}

export default async function MappingsPage() {
  const supabase = await createClient();

  const { data: claims, error: claimsErr } = await supabase.auth.getClaims();
  if (claimsErr || !claims?.claims) {
    redirect("/auth/login");
  }

  const sub = claims.claims.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    redirect("/auth/login");
  }
  const userId = sub;

  const { data: merchantData, error: merchantErr } = await supabase
    .from("merchants")
    .select("id, salla_store_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (merchantErr) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="pt-6">
            <p className="text-red-500">
              حدث خطأ في جلب بيانات التاجر: {merchantErr.message}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const merchant = merchantData as MerchantRow | null;

  if (!merchant) {
    return (
      <div className="p-6 space-y-4">
        <h1 className="text-3xl font-bold">تعيينات المنتج ↔ المصمم</h1>
        <Card>
          <CardHeader>
            <CardTitle>لا يوجد تاجر مرتبط بهذا الحساب</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              يجب إكمال ربط متجر سلة (OAuth) أولًا قبل إنشاء تعيينات. راجع المرحلة 9
              من خطة الإطلاق.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { data: rows, error: rowsErr } = await supabase
    .from("product_designer_map")
    .select(
      "id, salla_product_id, product_label, is_generic_variant, designer_name, designer_whatsapp, created_at",
    )
    .eq("merchant_id", merchant.id)
    .order("created_at", { ascending: false });

  if (rowsErr) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="pt-6">
            <p className="text-red-500">
              حدث خطأ في جلب التعيينات: {rowsErr.message}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const mappings: MappingRow[] = (rows ?? []) as MappingRow[];

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">تعيينات المنتج ↔ المصمم</h1>
          <p className="text-sm text-muted-foreground mt-1">
            متجر سلة رقم: <span className="font-mono">{merchant.salla_store_id}</span> —
            إجمالي التعيينات: <span className="font-semibold">{mappings.length}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <MappingDialog
            mode="create"
            trigger={
              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2"
              >
                <Plus className="ml-2 h-4 w-4" />
                تعيين جديد
              </button>
            }
          />
        </div>
      </div>

      <MappingsTable mappings={mappings} />
    </div>
  );
}
