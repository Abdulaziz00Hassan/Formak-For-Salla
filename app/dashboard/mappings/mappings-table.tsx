"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { DeleteMappingButton } from "./delete-mapping-button";
import { MappingDialog, type MappingRowInput } from "./mapping-dialog";

export interface MappingRow {
  id: string;
  salla_product_id: number;
  product_label: string;
  is_generic_variant: boolean | null;
  designer_name: string;
  designer_whatsapp: string;
  created_at: string;
}

interface MappingsTableProps {
  mappings: MappingRow[];
}

function formatWhatsApp(raw: string): string {
  if (raw.length === 12 && raw.startsWith("966")) {
    return `+${raw.slice(0, 3)} ${raw.slice(3, 5)} ${raw.slice(5, 8)} ${raw.slice(8)}`;
  }
  return raw;
}

export function MappingsTable({ mappings }: MappingsTableProps) {
  const [query, setQuery] = React.useState("");

  const filtered = React.useMemo<MappingRow[]>(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return mappings;
    return mappings.filter((m) => {
      return (
        m.product_label.toLowerCase().includes(q) ||
        m.designer_name.toLowerCase().includes(q) ||
        m.designer_whatsapp.toLowerCase().includes(q) ||
        String(m.salla_product_id).includes(q)
      );
    });
  }, [mappings, query]);

  if (mappings.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-center text-muted-foreground">
            لا توجد تعيينات بعد. أنشئ أول تعيين لربط منتج بمصمّم.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Input
          placeholder="ابحث بالاسم، رقم الواتساب، أو معرّف المنتج..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-md"
        />
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          عرض {filtered.length} من {mappings.length}
        </span>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>اسم المنتج</TableHead>
                <TableHead>معرّف المنتج</TableHead>
                <TableHead>المصمّم</TableHead>
                <TableHead>واتساب</TableHead>
                <TableHead>إجراءات</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="text-center py-8 text-muted-foreground"
                  >
                    لا توجد نتائج تطابق البحث.
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((row) => {
                  const editInput: MappingRowInput = {
                    id: row.id,
                    salla_product_id: row.salla_product_id,
                    product_label: row.product_label,
                    designer_name: row.designer_name,
                    designer_whatsapp: row.designer_whatsapp,
                  };
                  return (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <span>{row.product_label}</span>
                          {row.is_generic_variant === true && (
                            <Badge variant="secondary">بدون اسم</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs" dir="ltr">
                        {row.salla_product_id}
                      </TableCell>
                      <TableCell>{row.designer_name}</TableCell>
                      <TableCell className="font-mono text-sm" dir="ltr">
                        {formatWhatsApp(row.designer_whatsapp)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <MappingDialog
                            mode="edit"
                            initial={editInput}
                            trigger={
                              <Button variant="outline" size="sm">
                                تعديل
                              </Button>
                            }
                          />
                          <DeleteMappingButton
                            id={row.id}
                            productLabel={row.product_label}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
