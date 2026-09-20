import type { Block, ClaimCard, Grade, InspectTarget, OutlineLabel, RewriteFormat, SlopReport } from "./types";
import type { ContextSource, VerifiedSource } from "./source-tracer-client";

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
  /** The service worker went away before REWRITE_DONE or REWRITE_FATAL_ERROR; no more messages will come. */
  onDisconnect?: () => void;
}

/**
 * Reports a port the service worker dropped. Chrome only fires `onDisconnect` for the other end,
 * so a port this side closed is never reported; `settled` covers the same for any port already
 * closed by a final message.
 */
function onDropped(port: chrome.runtime.Port, settled: () => boolean, handler: (() => void) | undefined): void {
  port.onDisconnect.addListener(() => {
    if (!settled()) handler?.();
  });
}

/** Opens a "rewrite" port and streams progress back via handlers as each paragraph completes. */
/** Returns a cancel: disconnecting aborts the service worker's in-flight paragraph calls. */
export function startRewrite(blocks: Block[], grade: Grade, format: RewriteFormat, handlers: RewriteHandlers): () => void {
  const port = chrome.runtime.connect({ name: "rewrite" });
  let settled = false;

  port.onMessage.addListener((message: RewriteMessage) => {
    switch (message.type) {
      case "REWRITE_PROGRESS":
        handlers.onProgress(message);
        break;
      case "REWRITE_PARAGRAPH_ERROR":
        handlers.onParagraphError(message);
        break;
      case "REWRITE_DONE":
        settled = true;
        handlers.onDone(message);
        port.disconnect();
        break;
      case "REWRITE_FATAL_ERROR":
        settled = true;
        handlers.onFatalError(message);
        port.disconnect();
        break;
    }
  });
  onDropped(port, () => settled, handlers.onDisconnect);

  const request: RewriteRequest = { type: "REWRITE_REQUEST", blocks, grade, format };
  port.postMessage(request);
  return () => port.disconnect();
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
  /**
   * The service worker went away without CHAT_DONE or CHAT_ERROR; a turn in flight will never
   * finish. Not fired after `close`.
   */
  onDisconnect?: () => void;
}

export interface ChatSession {
  send: (messages: ChatTurn[]) => void;
  close: () => void;
}

/**
 * Opens a "chat" port. Call `send` once per turn with the full message history so far; the
 * service worker is stateless and replies by streaming CHAT_DELTA chunks, ending each turn with
 * CHAT_DONE or CHAT_ERROR. The port can carry as many turns as the caller likes and stays open
 * until `close` is called.
 */
export function openChatPort(handlers: ChatHandlers): ChatSession {
  const port = chrome.runtime.connect({ name: "chat" });
  let closed = false;

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
  onDropped(port, () => closed, handlers.onDisconnect);

  return {
    send: (messages) => {
      const request: ChatRequest = { type: "CHAT_REQUEST", messages };
      port.postMessage(request);
    },
    close: () => {
      closed = true;
      port.disconnect();
    },
  };
}

export type TraceState = "running" | "done" | "skipped" | "failed";

/** One step of the Inspector pipeline, shown in the card's trace so each stage's work is visible. */
export interface InspectTrace {
  type: "INSPECT_TRACE";
  step: string;
  state: TraceState;
  detail?: string;
  ms?: number;
}

export interface InspectRequest {
  type: "INSPECT_REQUEST";
  target: InspectTarget;
}

export interface InspectClaims {
  type: "INSPECT_CLAIMS";
  claims?: ClaimCard[];
  error?: string;
}

export interface InspectSlop {
  type: "INSPECT_SLOP";
  report?: SlopReport;
  /** Why there's no report: no key, passage too short, or the call failed. */
  note?: string;
}

export interface InspectSources {
  type: "INSPECT_SOURCES";
  sourcesByQuote: Record<string, VerifiedSource[]>;
  contextsByQuote: Record<string, ContextSource[]>;
  /**
   * Per-claim reason the tracer produced no result — no endpoint configured, or the run failed.
   * A quote absent from this map was actually checked, so an empty source list means "none found".
   */
  notCheckedByQuote: Record<string, string>;
}

export interface InspectDone {
  type: "INSPECT_DONE";
}

export type InspectMessage = InspectTrace | InspectClaims | InspectSlop | InspectSources | InspectDone;

export interface InspectHandlers {
  onTrace: (msg: InspectTrace) => void;
  onClaims: (msg: InspectClaims) => void;
  onSlop: (msg: InspectSlop) => void;
  onSources: (msg: InspectSources) => void;
  onDone: () => void;
  /** The service worker went away before INSPECT_DONE; the run is over. Not fired after cancel. */
  onDisconnect?: () => void;
}

/**
 * Opens an "inspect" port for one inspection. Claim extraction and the GPTZero slop check run in
 * parallel in the service worker, so claims, the slop report and trace steps each arrive as soon
 * as they're ready. Returns a cancel function that drops the inspection.
 */
export function startInspect(target: InspectTarget, handlers: InspectHandlers): () => void {
  const port = chrome.runtime.connect({ name: "inspect" });
  let settled = false;

  port.onMessage.addListener((message: InspectMessage) => {
    switch (message.type) {
      case "INSPECT_TRACE":
        handlers.onTrace(message);
        break;
      case "INSPECT_CLAIMS":
        handlers.onClaims(message);
        break;
      case "INSPECT_SLOP":
        handlers.onSlop(message);
        break;
      case "INSPECT_SOURCES":
        handlers.onSources(message);
        break;
      case "INSPECT_DONE":
        settled = true;
        handlers.onDone();
        port.disconnect();
        break;
    }
  });
  onDropped(port, () => settled, handlers.onDisconnect);

  const request: InspectRequest = { type: "INSPECT_REQUEST", target };
  port.postMessage(request);
  return () => {
    settled = true;
    port.disconnect();
  };
}

export interface OutlineRequestBlock {
  id: string;
  tag: string;
  text: string;
}

export interface OutlineRequest {
  type: "OUTLINE_REQUEST";
  title: string;
  blocks: OutlineRequestBlock[];
}

export interface OutlineResult {
  type: "OUTLINE_RESULT";
  labels?: { id: string; label: OutlineLabel }[];
  error?: string;
}

/** Asks the service worker to label outline blocks; resolves with its single reply. */
export function requestOutlineLabels(title: string, blocks: OutlineRequestBlock[]): Promise<OutlineResult> {
  return new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: "outline" });
    port.onMessage.addListener((message: OutlineResult) => {
      resolve(message);
      port.disconnect();
    });
    port.onDisconnect.addListener(() => resolve({ type: "OUTLINE_RESULT", error: "Connection closed." }));
    const request: OutlineRequest = { type: "OUTLINE_REQUEST", title, blocks };
    port.postMessage(request);
  });
}
