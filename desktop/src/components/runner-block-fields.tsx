"use client";

import { nodeCatalog, stepDefinition, operationAvailable, type WorkflowStep } from "@spool/workflow";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Dropdown } from "./ui/dropdown";
import { FilePicker } from "./ui/file-picker";

export function RunnerBlockFields({ step, onChange, agents, onBrowseFile, source }: {
  step: WorkflowStep; onChange: (patch: Partial<WorkflowStep>) => void; agents: string[];
  onBrowseFile: (signal: AbortSignal) => Promise<string | null>;
  source?: string;
}) {
  const operations = nodeCatalog.filter(node => node.kind === step.kind && operationAvailable(node, source));
  return <>{operations.length > 1 && <Dropdown label="Operation" value={step.operation || step.kind}
    options={operations.map(node => ({ value: node.id, label: node.label }))}
    onValueChange={id => {
      const next = operations.find(node => node.id === id)!;
      onChange({ operation: next.operation,
        ...Object.fromEntries((stepDefinition(step)?.fields || []).filter(field => !next.fields.some(item => item.key === field.key))
          .map(field => [field.key, undefined])),
        ...Object.fromEntries(next.fields.map(field => [field.key, step[field.key] ??
          field.defaultValue ?? (field.type === "select" ? field.options?.[0] : "")])) });
    }} />}{stepDefinition(step)?.fields.map(field => {
    const value = step[field.key] || "";
    if (field.type === "file") return <FilePicker key={field.key} label={field.label} value={value} kind="file"
      onBrowse={onBrowseFile} onValueChange={next => onChange({ [field.key]: next })} />;
    if (field.type === "select" || field.type === "agent") {
      const options = field.type === "agent" ? [...new Set([...agents, ...(value ? [value] : [])])] : field.options || [];
      return <Dropdown key={field.key} label={field.label} value={value}
        options={options.map(option => ({ value: option, label: option }))} onValueChange={next => onChange({ [field.key]: next })} />;
    }
    if (field.type === "textarea" || field.type === "json") return <Textarea key={field.key} label={field.label} value={value}
      rows={6} maxLength={16384} spellCheck={false}
      onChange={event => onChange({ [field.key]: event.target.value })} />;
    return <Input key={field.key} label={field.label} value={value} type={field.type === "number" ? "number" : "text"}
      min={field.min} max={field.max} step={field.type === "number" ? 1 : undefined}
      onChange={event => onChange({ [field.key]: event.target.value })} />;
  })}</>;
}
