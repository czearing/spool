"use client";

import dynamic from "../platform/lazy";
import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { SidebarSwitcher, type SidebarOption } from "./ui/sidebar";
import { MenuItem } from "./ui/menu";

const CreateProjectDialog = dynamic(() => import("./create-project-dialog"));
export function ProjectSwitcher({ value, options, disabled, onValueChange, onCreated }: {
  value: string; options: readonly SidebarOption[]; disabled?: boolean;
  onValueChange: (id: string) => void; onCreated: (id: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <SidebarSwitcher ref={trigger} label="Switch project" value={value} options={options} disabled={disabled} onValueChange={onValueChange}
      onCloseAutoFocus={(event) => { if (creating) event.preventDefault(); }}
      actions={<MenuItem icon={<Plus />} onSelect={() => setCreating(true)}>Create project...</MenuItem>} />
    {creating && <CreateProjectDialog onOpenChange={setCreating}
      onCreated={(id) => { setCreating(false); onCreated(id); }}
      onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus(); }} />}
  </>;
}
