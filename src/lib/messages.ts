import type { Block, Grade } from "./types";

export interface RewriteRequest {
  type: "REWRITE_REQUEST";
  blocks: Block[];
  grade: Grade;
}

export interface RewriteResult {
  type: "REWRITE_RESULT";
  patches: Block[];
}

export interface RewriteError {
  type: "REWRITE_ERROR";
  message: string;
}

export type RewriteResponse = RewriteResult | RewriteError;

export function sendRewriteRequest(blocks: Block[], grade: Grade): Promise<RewriteResponse> {
  const message: RewriteRequest = { type: "REWRITE_REQUEST", blocks, grade };
  return chrome.runtime.sendMessage(message);
}
