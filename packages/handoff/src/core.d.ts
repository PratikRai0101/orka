export type HandoffTool = "claude" | "codex" | "pi";
export type HandoffKind = "memory" | "skill" | "plan" | "session";
export type HandoffMessage = { role: "user" | "assistant"; text: string };
export type HandoffFile = { path: string; text: string };
export type HandoffItem = {
  kind: HandoffKind;
  title: string;
  tool?: HandoffTool;
  messages?: HandoffMessage[];
  files?: HandoffFile[];
};
export type HandoffRepository = {
  name: string;
  branch?: string;
  commit?: string;
  uncommitted?: boolean;
};
export type HandoffSession = {
  tool: HandoffTool;
  id?: string;
  cwd?: string;
  title: string;
  messages: HandoffMessage[];
  plan?: string;
  skills: { names: string[]; folders: string[] };
  plans: string[];
  mentions: string[];
};
export type HandoffBundle = {
  version: 1;
  requestId: string;
  title: string;
  tool: HandoffTool;
  messages: HandoffMessage[];
  repository?: HandoffRepository;
  items: HandoffItem[];
  expiresInDays?: number;
};
export const LIMITS: {
  bytes: number;
  items: number;
  files: number;
  messages: number;
  title: number;
};
export const TOOL_NAMES: Record<HandoffTool, string>;
export const KINDS: HandoffKind[];
export class HandoffError extends Error {}
export function redactText(text: string): string;
export function requestTitle(text: string): string | undefined;
export function decodeLines(text: string): unknown[];
export function readSession(records: unknown[]): HandoffSession;
export function itemSize(item: HandoffItem): number;
export function safePath(path: string): boolean;
export function credentialFile(path: string): boolean;
export function buildBundle(input: {
  session: Pick<HandoffSession, "tool" | "title" | "messages">;
  items?: HandoffItem[];
  repository?: HandoffRepository;
  title?: string;
  expiresInDays?: number;
  requestId: string;
}): { bundle: HandoffBundle; size: number; redacted: number };
export function continuationPrompt(url: string, tool: HandoffTool): string;
