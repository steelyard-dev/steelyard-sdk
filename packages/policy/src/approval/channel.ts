export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalPrompt {
  approval_prompt_id: string;
  nonce: string;
  policy_hash: string;
  authorization_hash: string;
  prompt_text: string;
  agent_rationale_quarantined?: string;
  expires_at: string;
}

export interface ApprovalChannel {
  prompt(req: ApprovalPrompt): Promise<{ approval_prompt_id: string; nonce: string }>;
  status(id: string): Promise<ApprovalStatus>;
}
