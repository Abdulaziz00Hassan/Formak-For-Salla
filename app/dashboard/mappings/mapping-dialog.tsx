"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { createMappingAction, updateMappingAction } from "./actions";
import {
  validateDesignerWhatsApp,
  validateSallaProductId,
} from "@/app/lib/validators";

export interface MappingRowInput {
  id: string;
  salla_product_id: number;
  product_label: string;
  designer_name: string;
  designer_whatsapp: string;
}

interface MappingDialogProps {
  mode: "create" | "edit";
  initial?: MappingRowInput;
  trigger: React.ReactNode;
}

export function MappingDialog({ mode, initial, trigger }: MappingDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [isPending, setIsPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [productLabel, setProductLabel] = React.useState(
    initial?.product_label ?? "",
  );
  const [sallaProductId, setSallaProductId] = React.useState(
    initial ? String(initial.salla_product_id) : "",
  );
  const [designerName, setDesignerName] = React.useState(
    initial?.designer_name ?? "",
  );
  const [designerWhatsApp, setDesignerWhatsApp] = React.useState(
    initial?.designer_whatsapp ?? "",
  );

  const reset = React.useCallback((): void => {
    if (mode === "create") {
      setProductLabel("");
      setSallaProductId("");
      setDesignerName("");
      setDesignerWhatsApp("");
    } else if (initial) {
      setProductLabel(initial.product_label);
      setSallaProductId(String(initial.salla_product_id));
      setDesignerName(initial.designer_name);
      setDesignerWhatsApp(initial.designer_whatsapp);
    }
    setError(null);
  }, [mode, initial]);

  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    if (!next) reset();
  };

  const handleSubmit = async (
    e: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    e.preventDefault();
    setError(null);

    if (productLabel.trim().length === 0) {
      setError("اسم المنتج مطلوب.");
      return;
    }
    if (designerName.trim().length === 0) {
      setError("اسم المصمم مطلوب.");
      return;
    }

    if (mode === "create") {
      const productCheck = validateSallaProductId(sallaProductId);
      if (!productCheck.isValid) {
        setError(productCheck.error);
        return;
      }
    }

    const whatsappCheck = validateDesignerWhatsApp(designerWhatsApp);
    if (!whatsappCheck.isValid) {
      setError(whatsappCheck.error);
      return;
    }

    const formData = new FormData();
    formData.set("product_label", productLabel.trim());
    formData.set("designer_name", designerName.trim());
    formData.set("designer_whatsapp", designerWhatsApp.trim());
    if (mode === "create") {
      formData.set("salla_product_id", sallaProductId.trim());
    }

    setIsPending(true);
    const result =
      mode === "create"
        ? await createMappingAction(formData)
        : await updateMappingAction(initial!.id, formData);
    setIsPending(false);

    if (!result.ok) {
      setError(result.error ?? "حدث خطأ غير متوقع.");
      return;
    }

    setOpen(false);
    reset();
    router.refresh();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "تعيين جديد" : "تعديل التعيين"}
          </DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "اربط منتجًا بسلة بمصمّم معيّن لتصلك إشعارات واتساب عند كل طلب."
              : "حدّث بيانات التعيين الحالي."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="product_label">اسم المنتج (للتعرّف فقط)</Label>
            <Input
              id="product_label"
              name="product_label"
              value={productLabel}
              onChange={(e) => setProductLabel(e.target.value)}
              required
              maxLength={200}
              placeholder="مثال: ميدالية مفاتيح خشبية"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="salla_product_id">معرّف المنتج بسلة</Label>
            <Input
              id="salla_product_id"
              name="salla_product_id"
              value={sallaProductId}
              onChange={(e) => setSallaProductId(e.target.value)}
              required
              disabled={mode === "edit"}
              inputMode="numeric"
              pattern="\d{1,19}"
              placeholder="مثال: 1234567890"
            />
            {mode === "edit" && (
              <p className="text-xs text-muted-foreground">
                لا يمكن تغيير المعرّف بعد الإنشاء.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="designer_name">اسم المصمّم</Label>
            <Input
              id="designer_name"
              name="designer_name"
              value={designerName}
              onChange={(e) => setDesignerName(e.target.value)}
              required
              maxLength={100}
              placeholder="مثال: سارة"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="designer_whatsapp">رقم واتساب المصمّم</Label>
            <Input
              id="designer_whatsapp"
              name="designer_whatsapp"
              value={designerWhatsApp}
              onChange={(e) => setDesignerWhatsApp(e.target.value)}
              required
              inputMode="numeric"
              dir="ltr"
              placeholder="9665xxxxxxxx"
            />
            <p className="text-xs text-muted-foreground">
              يبدأ بـ966 بدون علامة +. مثال:{" "}
              <span className="font-mono">966501234567</span>
            </p>
          </div>

          {error && (
            <p className="text-sm text-red-500" role="alert">
              {error}
            </p>
          )}

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isPending}
            >
              إلغاء
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending
                ? "جاري الحفظ..."
                : mode === "create"
                  ? "إنشاء"
                  : "حفظ التعديلات"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
