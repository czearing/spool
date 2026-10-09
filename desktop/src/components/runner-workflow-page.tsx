"use client";

import { useState } from "react";
import { useRouter } from "../platform/navigation";
import dynamic from "../platform/lazy";
import { newRunnerWorkflow } from "../lib/runner-workflow";
import { useRunnerWorkflow } from "../hooks/use-runner-workflow";
import { browseLocalPath } from "../lib/local-file-picker";
import { useNavigationGuard } from "./navigation-guard";
import { useProjectLive } from "./project-live-provider";
import { workflowExecutionApi } from "../lib/workflow-executions";
import { Button } from "./ui/button";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";
import styles from "./runner-workflow.module.css";

const Editor = dynamic(() => import("./runner-workflow-editor").then(module => module.RunnerWorkflowEditor), { ssr: false });
export function RunnerWorkflowPage({ project, id }: { project: string; id: string }) {
  const { query, mutation } = useRunnerWorkflow(project, id);
  const [draft] = useState(newRunnerWorkflow);
  const guard = useNavigationGuard(), router = useRouter();
  const live = useProjectLive();
  const initial = id === "new" ? draft : query.data;
  if (query.error) return <Stack gap={3} className={styles.loading}>
    <Text role="alert">{query.error.message}</Text><Button onClick={() => void query.refetch()}>Retry</Button>
  </Stack>;
  if (!initial) return <Text role="status" className={styles.loading}>Loading runner...</Text>;
  return <Editor key={id} initial={initial} onDirtyChange={guard.setDirty} onBrowse={signal => browseLocalPath("folder", signal)}
    executions={workflowExecutionApi(project, initial.id)}
    onBrowseFile={signal => browseLocalPath("file", signal)}
    agents={live.data?.agents.map(agent => agent.id)} agentsError={live.error?.message}
    onBack={() => guard.navigate(`/${project}/runners`)}
    onSave={async value => {
      const saved = await mutation.mutateAsync(value);
      if (id === "new") { guard.setDirty(false); router.replace(`/${project}/runners/${saved.id}`); }
      return saved;
    }} />;
}
