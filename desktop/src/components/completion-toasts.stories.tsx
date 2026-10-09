import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { CompletionToasts } from "./completion-toasts";
import { Button } from "./ui/button";
import type { JobCompletion } from "../lib/job-completions";

const meta = { title: "Jobs/Completion notifications", component: CompletionToasts,
  args: { notifications: [], onDismiss: () => {} },
  render: function Example() {
    const [items, setItems] = useState<JobCompletion[]>([]);
    return <><Button onClick={() => setItems((previous) => [...previous,
      { key: crypto.randomUUID(), id: "job", title: "Improve page loading", agent: "engineer" }])}>Complete job</Button>
      <CompletionToasts notifications={items} onDismiss={(key) => setItems((previous) => previous.filter((item) => item.key !== key))} /></>;
  },
} satisfies Meta<typeof CompletionToasts>;
export default meta;
export const Default: StoryObj<typeof meta> = {};
