import type { WorkItem } from "./work-items";

export const seedItems: WorkItem[] = [
  { id: "1", title: "Plan next release", status: "backlog" },
  { id: "2", title: "Review requirements", status: "backlog" },
  { id: "3", title: "Build components", status: "in-progress" },
  { id: "4", title: "Write tests", status: "in-progress" },
  { id: "5", title: "Set up project", status: "completed" },
  { id: "6", title: "API access", status: "blocked" },
];
