/** PG-001 だけで使う型（API-034 の応答の形。src/types.ts は変えない） */
export interface ThreadInfo {
  id: string;
  title: string;
  lastPresetId: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  autoApprove: boolean;
}

export interface ThreadMessage {
  id: string;
  turnId?: string | null;
  role: string;
  content: string;
  reasoning: string | null;
  toolCallId?: string | null;
  compactedAt?: string | null;
}

export type TurnStatus = "running" | "awaiting_approval" | "step_limit" | "completed" | "cancelled" | "failed";

export interface TurnInfo {
  id: string;
  status: TurnStatus;
  stepCount: number;
  stepLimit: number;
  presetId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  error: string | null;
}

export interface ToolCall {
  id: string;
  turnId: string;
  tool: string;
  args: unknown;
  kind: string;
  status: string;
  output: string | null;
  exitCode: number | null;
  decisionNote: string | null;
  /** 承認待ちの書き込みの unified diff */
  preview?: string;
}

/** プロジェクト（TBL-005）。autoApprove の null は設定に従う */
export interface Workspace {
  id: string;
  path: string;
  name: string;
  instructions: string | null;
  defaultPresetId: string | null;
  autoApprove: boolean | null;
}

/** API-039（TBL-009）。応答の形は未確定なので、読む側で欠けを許す */
export interface FileChange {
  id: string;
  toolCallId: string;
  path: string;
  before: string | null;
  after: string | null;
  revertedAt: string | null;
  createdAt: string;
}
