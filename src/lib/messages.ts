import type { Block, Grade, RewriteFormat } from "./types";

export interface RewritePatch {
  id: string;
  text?: string;
  bullets?: string[];
}

export interface RewriteRequest {
  type: "REWRITE_REQUEST";
  blocks: Block[];
  grade: Grade;
  format: RewriteFormat;
}

export interface RewriteProgress {
  type: "REWRITE_PROGRESS";
  patch: RewritePatch;
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
export function startRewrite(blocks: Block[], grade: Grade, format: RewriteFormat, handlers: RewriteHandlers): void {
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

  const request: RewriteRequest = { type: "REWRITE_REQUEST", blocks, grade, format };
  port.postMessage(request);
}

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  type: "CHAT_REQUEST";
  messages: ChatTurn[];
}

export interface ChatDelta {
  type: "CHAT_DELTA";
  delta: string;
}

export interface ChatDone {
  type: "CHAT_DONE";
}

export interface ChatError {
  type: "CHAT_ERROR";
  message: string;
}

export type ChatResponseMessage = ChatDelta | ChatDone | ChatError;

export interface ChatHandlers {
  onDelta: (msg: ChatDelta) => void;
  onDone: (msg: ChatDone) => void;
  onError: (msg: ChatError) => void;
}

export interface ChatSession {
  send: (messages: ChatTurn[]) => void;
  close: () => void;
}

/**
 * Opens a long-lived "chat" port for a whole conversation. Call `send` once per turn with the
 * full message history so far; the service worker is stateless and replies by streaming
 * CHAT_DELTA chunks, ending each turn with CHAT_DONE or CHAT_ERROR. The port stays open across
 * turns until `close` is called.
 */
export function openChatPort(handlers: ChatHandlers): ChatSession {
  const port = chrome.runtime.connect({ name: "chat" });

  port.onMessage.addListener((message: ChatResponseMessage) => {
    switch (message.type) {
      case "CHAT_DELTA":
        handlers.onDelta(message);
        break;
      case "CHAT_DONE":
        handlers.onDone(message);
        break;
      case "CHAT_ERROR":
        handlers.onError(message);
        break;
    }
  });

  return {
    send: (messages) => {
      const request: ChatRequest = { type: "CHAT_REQUEST", messages };
      port.postMessage(request);
    },
    close: () => port.disconnect(),
  };
}
