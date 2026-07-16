"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { deleteMappingAction } from "./actions";

interface DeleteMappingButtonProps {
  id: string;
  productLabel: string;
}

export function DeleteMappingButton({ id, productLabel }: DeleteMappingButtonProps) {
  const router = useRouter();
  const [isPending, setIsPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleDelete = async (): Promise<void> => {
    const confirmed = window.confirm(
      `هل تريد فعلاً حذف تعيين "${productLabel}"؟ هذا الإجراء لا يمكن التراجع عنه.`,
    );
    if (!confirmed) return;

    setIsPending(true);
    setError(null);
    const result = await deleteMappingAction(id);
    setIsPending(false);

    if (!result.ok) {
      setError(result.error ?? "فشل الحذف.");
      return;
    }
    router.refresh();
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        variant="destructive"
        size="sm"
        onClick={handleDelete}
        disabled={isPending}
      >
        <Trash2 className="ml-1 h-3.5 w-3.5" />
        {isPending ? "جاري الحذف..." : "حذف"}
      </Button>
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  );
}
