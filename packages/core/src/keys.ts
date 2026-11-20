/** Permissions an access key can have. Settings, security, and the vault are never among them. */
export const KEY_SCOPES = ["read", "converse", "approve", "act", "memory", "work"] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

export const SCOPE_TEXT: Record<KeyScope, string> = {
  read: "See status: services, incidents, and what needs you",
  converse: "Talk to the AI operator (for Belle and Home Assistant)",
  approve: "Approve or decline repairs that ask first (never the always-ask list)",
  act: "Run checks and restart services, as if you pressed the button",
  memory:
    "Read and add to the homelab memory, with a summary of your systems (for Claude Code). Never deletes",
  work: "Report progress of long jobs, like voice training or a big copy, so a stalled one is noticed",
};

export interface KeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: KeyScope[];
  createdAt: string;
  lastUsedAt?: string;
}
