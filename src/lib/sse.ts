/**
 * Splits a Server-Sent Events stream into its `data:` payloads.
 *
 * Chunks arrive at arbitrary byte boundaries, so a line can straddle two reads; the partial tail
 * is held back until the next `push`. Anything that is not a `data:` line is skipped, and nothing
 * after `[DONE]` is ever returned.
 */
export class SseParser {
  private buffer = "";
  private finished = false;

  /** Whether `[DONE]` has been seen; there is nothing left to read once it has. */
  get done(): boolean {
    return this.finished;
  }

  /** The complete payloads in this chunk. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return this.take(lines);
  }

  /** The payloads in a final chunk plus whatever a stream ending without a trailing newline left behind. */
  end(chunk = ""): string[] {
    const payloads = this.push(chunk);
    const rest = this.buffer;
    this.buffer = "";
    return payloads.concat(this.take([rest]));
  }

  private take(lines: string[]): string[] {
    const payloads: string[] = [];
    for (const line of lines) {
      if (this.finished) break;
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice("data:".length).trim();
      if (payload === "[DONE]") {
        this.finished = true;
        break;
      }
      payloads.push(payload);
    }
    return payloads;
  }
}

/** The text delta in one OpenAI-style chat completion chunk, or null when it carries none. */
export function chatDelta(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { choices?: { delta?: { content?: unknown } }[] } | null;
    const delta = parsed?.choices?.[0]?.delta?.content;
    return typeof delta === "string" && delta.length > 0 ? delta : null;
  } catch {
    return null;
  }
}
