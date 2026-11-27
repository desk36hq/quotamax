// Types for "Apply" shared by the panel and the worker. Kept apart from apply.ts so the
// panel never imports the module that types into terminals (a worker-only host call).

export interface ApplyRequest {
  provider: string;
  modelId: string;
  label: string;
  thinking: string | null;
  /** False: preview only. True: send to `terminalId` (from the preview). */
  confirm: boolean;
  terminalId?: string;
}

export type ApplyStatus = "ready" | "sent" | "manual" | "no-agent" | "busy" | "failed";

export interface ApplyResult {
  status: ApplyStatus;
  message: string;
  /** What is (or would be) typed, or what to run by hand for `manual` / `no-agent`. */
  commands: string[];
  terminalId?: string;
  agentTitle?: string;
}
