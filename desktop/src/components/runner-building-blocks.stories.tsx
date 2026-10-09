import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { RunnerWorkflowEditor } from "./runner-workflow-editor";
import { RunnerWorkflowFields } from "./runner-workflow-fields";
import type { RunnerWorkflow } from "../lib/runner-workflow";
import type { WorkflowExecutionApi, WorkflowRun } from "../lib/workflow-executions";

const initial: RunnerWorkflow = { id: "webhook-example", name: "Webhook automation", kind: "custom", revision: "story", enabled: false,
  workspace: "C:\\Work\\automation", intervalSeconds: 60, nodes: [
    { id: "trigger", kind: "webhook", label: "Receive webhook", secretEnv: "AUTOMATION_WEBHOOK_TOKEN", position: { x: 0, y: 0 } },
    { id: "filter", kind: "filter", label: "Only opened items", field: "action", operator: "equals", compare: "opened", position: { x: 224, y: 0 } },
    { id: "data", kind: "data", label: "Prepare task data", body: '{"title":"{{input.title}}","action":"{{input.action}}"}', position: { x: 448, y: 0 } },
    { id: "http", kind: "http", label: "Send to API", url: "https://example.invalid/tasks", method: "POST", body: "{{input}}", position: { x: 672, y: 0 } },
  ], edges: [{ id: "first", source: "trigger", target: "filter" }, { id: "second", source: "filter", target: "data" }, { id: "third", source: "data", target: "http" }] };
function Example() {
  const [client] = useState(() => new QueryClient());
  const [api] = useState<WorkflowExecutionApi>(() => {
    const records = new Map<string, WorkflowRun>();
    return { webhookUrl: "/isolated-story/webhook (mock; no external requests)",
      list: async () => [...records.values()].reverse(),
      read: async id => { const record = records.get(id); if (!record) throw new Error("Story execution not found."); return record; },
      run: async (input, _revision, id) => {
        records.set(id, { id, status: "succeeded", source: "story fixture", createdAt: new Date().toISOString(), input,
          steps: initial.nodes.slice(1).map(node => ({ id: node.id, label: node.label, status: "succeeded", input,
            output: node.kind === "http" ? { status: 201, body: { id: "fixture-42" } } : input })) });
        return { id };
      },
    };
  });
  return <QueryClientProvider client={client}><RunnerWorkflowEditor initial={initial} executions={api}
    onBack={() => {}} onSave={async value => ({ ...value, revision: "story-saved" })}
    onBrowse={async () => "C:\\Work\\automation"} onBrowseFile={async () => "C:\\Work\\automation\\input.json"}
    agents={["editor", "engineer"]} /></QueryClientProvider>;
}
const meta = { title: "Runners/Building blocks", component: Example, parameters: { layout: "fullscreen" } } satisfies Meta<typeof Example>;
export default meta;
export const WebhookAutomation: StoryObj<typeof meta> = {};
function NodeParameters() {
  const [value, setValue] = useState(initial), [open, setOpen] = useState(true);
  return <><Example />{open && <RunnerWorkflowFields value={value} selected="http" onChange={setValue}
    onClose={() => setOpen(false)} onRemove={() => setOpen(false)} onChangeTrigger={() => {}}
    onBrowse={async () => null} onBrowseFile={async () => null} agents={[]} />}</>;
}
export const HttpParameters: StoryObj<typeof meta> = { render: () => <NodeParameters /> };
