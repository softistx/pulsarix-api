import type { StatusCategory } from "./projects.model";

// The workflow a new project starts with, in order.
export const defaultWorkflow: readonly {
  name: string;
  category: StatusCategory;
  colour: string;
}[] = [
  { name: "Triage", category: "triage", colour: "#9ca3af" },
  { name: "Backlog", category: "backlog", colour: "#6b7280" },
  { name: "Todo", category: "todo", colour: "#3b82f6" },
  { name: "In progress", category: "inProgress", colour: "#f59e0b" },
  { name: "Done", category: "done", colour: "#22c55e" },
  { name: "Cancelled", category: "cancelled", colour: "#ef4444" },
];
