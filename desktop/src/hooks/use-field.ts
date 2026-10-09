import { useId, type ReactNode } from "react";

export function useField({ id, description, error, describedBy }: {
  id?: string; description?: ReactNode; error?: string; describedBy?: string;
}) {
  const generated = useId();
  const fieldId = id ?? generated;
  return {
    id: fieldId,
    describedBy: [describedBy, description && `${fieldId}-description`, error && `${fieldId}-error`].filter(Boolean).join(" ") || undefined,
  };
}
