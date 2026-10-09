import { integrationNodes } from "./integrations.mjs";
const field = (key, label, type = "text", description, options) => ({ key, label, type, description, options });
export const repositoryOperations = ["refresh", "setup", "build", "check"];
export const nodeCatalog = [
  { id: "schedule", kind: "schedule", group: "Triggers", label: "On a schedule", description: "Run at a regular interval.", icon: "clock", fields: [] },
  { id: "file-change", kind: "file-change", group: "Triggers", label: "When a file changes", description: "React to a file being edited, created or deleted.", icon: "file",
    fields: [field("path", "File to watch", "file", "Relative to the working directory, or an absolute path. First check establishes a baseline.")] },
  { id: "refresh", kind: "repository", operation: "refresh", group: "Repository", label: "Refresh repository", description: "Fetch the latest master without switching or merging your branch.", icon: "refresh", fields: [] },
  { id: "setup", kind: "repository", operation: "setup", group: "Repository", label: "Prepare workspace", description: "Install dependencies and warm the existing checkout's build.", icon: "folder", fields: [] },
  { id: "build", kind: "repository", operation: "build", group: "Repository", label: "Build repository", description: "Run the repository-owned dependency build.", icon: "build", fields: [] },
  { id: "check", kind: "repository", operation: "check", group: "Repository", label: "Check changes", description: "Run the required repository validation gates.", icon: "check", fields: [] },
  { id: "agent", kind: "agent", group: "Spool", label: "Assign agent task", description: "Hand work to an existing agent with durable task delivery.", icon: "agent",
    fields: [field("agent", "Agent", "agent"), field("prompt", "Task instructions", "textarea", "Supports {{input.title}}. Handoff is final; agent work is asynchronous.")] },
  { id: "command", kind: "command", group: "Advanced", label: "Run script", description: "Run PowerShell with the previous step's JSON input.", icon: "terminal",
    fields: [field("command", "PowerShell command", "textarea", "Read input with $env:SPOOL_INPUT | ConvertFrom-Json. JSON stdout becomes the next step's input; other stdout becomes text. Runs with your account's permissions.")] },
  { id: "manual", kind: "manual", group: "Triggers", label: "Run manually", description: "Start a run with JSON input from the editor.", icon: "play", fields: [] },
  { id: "webhook", kind: "webhook", group: "Triggers", label: "Receive webhook", description: "Accept an authenticated JSON event at a local endpoint.", icon: "webhook",
    fields: [field("secretEnv", "Webhook token environment variable", "env", "Name of an environment variable available to the UI server, with a token at least 32 characters long. Never enter the token itself.")] },
  { id: "http", kind: "http", group: "Network", label: "HTTP request", description: "Call an HTTP API and pass its response to the next step.", icon: "globe",
    fields: [field("url", "URL", "text", "An http(s) URL. Supports {{input.id}}."),
      field("method", "Method", "select", undefined, ["GET", "POST", "PUT", "PATCH", "DELETE"]),
      field("body", "JSON body", "json", "Optional. {{input}} forwards the complete input; values such as {{input.title}} can be mapped inside JSON."),
      field("bearerEnv", "Bearer token environment variable", "env", "Optional variable name from the runner process. Credentials are not saved in the workflow.")] },
  { id: "data", kind: "data", group: "Data", label: "Edit data", description: "Build JSON for the next action from previous results.", icon: "data",
    fields: [field("body", "Output JSON", "json", 'Example: {"title":"{{input.title}}","source":"{{steps.trigger}}"}')] },
  { id: "filter", kind: "filter", group: "Flow", label: "Filter", description: "Continue only when a condition matches; otherwise finish as filtered.", icon: "filter",
    fields: [field("field", "Input field", "text", "Dot-separated JSON field, for example status or pullRequest.id."),
      field("operator", "Condition", "select", undefined, ["equals", "not-equals", "exists", "contains"]),
      field("compare", "Compare with", "text", "For equals, not-equals or contains. Plain text or a JSON scalar (true, 42).")] },
  ...integrationNodes,
];
export const isTrigger = step => stepDefinition(step)?.group === "Triggers";
export const stepDefinition = step => nodeCatalog.find(node => node.kind === step.kind && node.id === (step.operation || step.kind));
export function stepError(step) {
  const definition = stepDefinition(step);
  if (!definition) return step.kind === "repository" ? "Choose a repository operation." : "Choose a supported block.";
  const required = step.operation === "resume-event" ? ["prompt"] : step.operation === "publish-fixes" ? ["agent"] :
    { command: ["command"], agent: ["agent", "prompt"], "file-change": ["path"],
    webhook: ["secretEnv"], http: ["url"], data: ["body"], filter: ["field", "operator"] }[step.kind] || [];
  for (const key of required) if (typeof step[key] !== "string" || !step[key].trim())
    return key === "command" ? `Enter a PowerShell command for "${step.label}".` :
      `Enter ${definition.fields.find(field => field.key === key)?.label.toLowerCase() || key} for "${step.label}".`;
  for (const field of definition.fields) {
    const value = step[field.key];
    if (value !== undefined && (typeof value !== "string" || value.length > 16384 || value.includes("\0"))) return `Invalid ${field.label.toLowerCase()}.`;
    if (value && field.type === "env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return `Enter an environment variable name for ${field.label.toLowerCase()}.`;
    if (value && field.type === "select" && !field.options.includes(value)) return `Choose a valid ${field.label.toLowerCase()}.`;
    if (field.type === "number" && (!value?.trim() || !Number.isSafeInteger(Number(value)) ||
        Number(value) < field.min || Number(value) > field.max)) return `${field.label} must be an integer from ${field.min} to ${field.max}.`;
    if (value && field.type === "json") {
      try { if (!/^\s*\{\{[\w.]+\}\}\s*$/.test(value)) JSON.parse(value); }
      catch { return `Enter valid JSON for ${field.label.toLowerCase()}; put mapped fields inside JSON strings.`; }
    }
  }
  if (step.kind === "http" && !/^https?:\/\//i.test(step.url)) return "HTTP requests require an http(s) URL.";
  if (["dispatch-event", "resume-event"].includes(step.operation) && !step.prompt?.includes("{{event.prompt}}"))
    return "Keep {{event.prompt}} in event task instructions so the source revision and delivery contract are preserved.";
}
