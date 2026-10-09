"use client";

import dynamic from "../platform/lazy";
import { useRef, useState } from "react";
import { useRouter } from "../platform/navigation";
import { Button } from "./ui/button";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";
import styles from "./app-shell.module.css";

const CreateProjectDialog = dynamic(() => import("./create-project-dialog"));
export function ProjectSetup() {
  const [open, setOpen] = useState(false), router = useRouter();
  const trigger = useRef<HTMLButtonElement>(null);
  return <Stack asChild gap={4}><main className={styles.home}>
    <Text asChild variant="heading"><h1 className={styles.heading}>Projects</h1></Text>
    <Text tone="secondary">Connect a local Spool folder to get started.</Text>
    <div><Button ref={trigger} onClick={() => setOpen(true)}>Create project</Button></div>
    {open && <CreateProjectDialog onOpenChange={setOpen} onCreated={(id) => router.push(`/${id}`)}
      onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus(); }} />}
  </main></Stack>;
}
