import type { WorkflowHandler } from "../registry";

export const handler: WorkflowHandler = () =>
  Promise.resolve({ status: "failed", reason: "not-implemented" });
