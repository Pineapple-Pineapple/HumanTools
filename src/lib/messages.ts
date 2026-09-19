import type { Block, Grade } from "./types";

export interface RewriteRequest {
  type: "REWRITE_REQUEST";
  blocks: Block[];
  grade: Grade;
}

export interface RewriteProgress {
  type: "REWRITE_PROGRESS";
  patch: Block;
  done: number;
  total: number;
}

export interface RewriteParagraphError {
  type: "REWRITE_PARAGRAPH_ERROR";
  id: string;
  message: string;
  done: number;
  total: number;
}

export interface RewriteDone {
  type: "REWRITE_DONE";
  succeeded: number;
  failed: number;
}

export interface RewriteFatalError {
  type: "REWRITE_FATAL_ERROR";
  message: string;
}

export type RewriteMessage = RewriteProgress | RewriteParagraphError | RewriteDone | RewriteFatalError;

export interface RewriteHandlers {
  onProgress: (msg: RewriteProgress) => void;
  onParagraphError: (msg: RewriteParagraphError) => void;
  onDone: (msg: RewriteDone) => void;
  onFatalError: (msg: RewriteFatalError) => void;
}

/** Opens a "rewrite" port and streams progress back via handlers as each paragraph completes. */
export function startRewrite(blocks: Block[], grade: Grade, handlers: RewriteHandlers): void {
  const port = chrome.runtime.connect({ name: "rewrite" });

  port.onMessage.addListener((message: RewriteMessage) => {
    switch (message.type) {
      case "REWRITE_PROGRESS":
        handlers.onProgress(message);
        break;
      case "REWRITE_PARAGRAPH_ERROR":
        handlers.onParagraphError(message);
        break;
      case "REWRITE_DONE":
        handlers.onDone(message);
        port.disconnect();
        break;
      case "REWRITE_FATAL_ERROR":
        handlers.onFatalError(message);
        port.disconnect();
        break;
    }
  });

  const request: RewriteRequest = { type: "REWRITE_REQUEST", blocks, grade };
  port.postMessage(request);
}
