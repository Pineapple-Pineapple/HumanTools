import type { CandidateSource } from "./source-candidates";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface FetchedSource {
  title: string;
  url: string;
  text: string;
}

type DocumentReader = (connectUrl: string, targetUrl: string, signal: AbortSignal) => Promise<FetchedSource>;

export class TransientBrowserbaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientBrowserbaseError";
  }
}

interface CdpResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (reason: Error) => void }>();

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => this.onMessage(event));
    socket.addEventListener("error", () => this.rejectPending(new TransientBrowserbaseError("Browserbase CDP connection failed.")));
    socket.addEventListener("close", () => this.rejectPending(new TransientBrowserbaseError("Browserbase CDP connection closed.")));
  }

  request(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void {
    this.socket.close();
  }

  private onMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") return;
    let message: CdpResponse;
    try {
      message = JSON.parse(event.data) as CdpResponse;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message ?? "Browserbase CDP request failed."));
    else pending.resolve(message.result ?? {});
  }

  private rejectPending(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}

async function openCdp(connectUrl: string, signal: AbortSignal): Promise<CdpConnection> {
  const socket = new WebSocket(connectUrl);
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    socket.addEventListener("open", () => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      signal.removeEventListener("abort", abort);
      reject(new TransientBrowserbaseError("Browserbase CDP connection failed."));
    }, { once: true });
  });
  return new CdpConnection(socket);
}

async function readBrowserbaseDocument(connectUrl: string, targetUrl: string, signal: AbortSignal): Promise<FetchedSource> {
  const cdp = await openCdp(connectUrl, signal);
  let targetId: string | undefined;
  try {
    const created = await cdp.request("Target.createTarget", { url: "about:blank" });
    targetId = String(created.targetId);
    const attached = await cdp.request("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = String(attached.sessionId);
    await cdp.request("Page.enable", {}, sessionId);
    await cdp.request("Page.navigate", { url: targetUrl }, sessionId);

    for (let attempt = 0; attempt < 30; attempt++) {
      const state = await cdp.request("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, sessionId);
      const readyState = (state.result as { value?: unknown } | undefined)?.value;
      if (readyState === "complete" || readyState === "interactive") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const evaluation = await cdp.request(
      "Runtime.evaluate",
      {
        expression: "JSON.stringify({title:document.title,url:location.href,text:(document.body?.innerText||'').slice(0,200000)})",
        returnByValue: true,
      },
      sessionId,
    );
    const json = (evaluation.result as { value?: unknown } | undefined)?.value;
    if (typeof json !== "string") throw new Error("Browserbase returned no readable document.");
    const document = JSON.parse(json) as Record<string, unknown>;
    if (typeof document.url !== "string" || typeof document.text !== "string") throw new Error("Browserbase returned malformed document text.");
    return { title: typeof document.title === "string" ? document.title : "Untitled source", url: document.url, text: document.text };
  } finally {
    if (targetId) await cdp.request("Target.closeTarget", { targetId }).catch(() => {});
    cdp.close();
  }
}

export class BrowserbaseFetcher {
  private readonly fetcher: Fetcher;
  private readonly readDocument: DocumentReader;

  constructor(options: { apiKey: string; projectId: string; fetcher?: Fetcher; readDocument?: DocumentReader }) {
    this.apiKey = options.apiKey;
    this.projectId = options.projectId;
    this.fetcher = options.fetcher ?? fetch;
    this.readDocument = options.readDocument ?? readBrowserbaseDocument;
  }

  private readonly apiKey: string;
  private readonly projectId: string;

  async fetch(candidate: CandidateSource): Promise<FetchedSource> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12_000);
      let sessionId: string | undefined;
      try {
        const session = await this.createSession(controller.signal);
        sessionId = session.id;
        return await this.readDocument(session.connectUrl, candidate.url, controller.signal);
      } catch (error) {
        lastError = error;
        if (!(error instanceof TransientBrowserbaseError) || attempt === 1) throw error;
      } finally {
        clearTimeout(timeout);
        if (sessionId) await this.releaseSession(sessionId).catch(() => {});
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Browserbase fetch failed.");
  }

  private async createSession(signal: AbortSignal): Promise<{ id: string; connectUrl: string }> {
    const response = await this.fetcher("https://api.browserbase.com/v1/sessions", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-BB-API-Key": this.apiKey },
      body: JSON.stringify({ projectId: this.projectId, timeout: 60 }),
      signal,
    });
    if (!response.ok) {
      const error = new Error(`Browserbase session creation failed (${response.status}).`);
      if (response.status === 408 || response.status === 429 || response.status >= 500) throw new TransientBrowserbaseError(error.message);
      throw error;
    }
    const session = await response.json() as Record<string, unknown>;
    if (typeof session.id !== "string" || typeof session.connectUrl !== "string") throw new Error("Browserbase returned malformed session details.");
    return { id: session.id, connectUrl: session.connectUrl };
  }

  private async releaseSession(sessionId: string): Promise<void> {
    await this.fetcher(`https://api.browserbase.com/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-BB-API-Key": this.apiKey },
      body: JSON.stringify({ status: "REQUEST_RELEASE" }),
    });
  }
}
