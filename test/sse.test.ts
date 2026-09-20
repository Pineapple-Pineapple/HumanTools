import { describe, expect, it } from "vitest";
import { SseParser, chatDelta } from "../src/lib/sse";

const chunk = (text: string) => `data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n`;

describe("SseParser", () => {
  it("returns each data payload once a full line has arrived", () => {
    const parser = new SseParser();
    expect(parser.push(chunk("a") + chunk("b"))).toEqual([
      '{"choices":[{"delta":{"content":"a"}}]}',
      '{"choices":[{"delta":{"content":"b"}}]}',
    ]);
  });

  it("holds a line split across two reads until the rest arrives", () => {
    const parser = new SseParser();
    const line = chunk("hello");
    expect(parser.push(line.slice(0, 12))).toEqual([]);
    expect(parser.push(line.slice(12))).toEqual(['{"choices":[{"delta":{"content":"hello"}}]}']);
  });

  it("stops at [DONE] even when it sits in the middle of a chunk", () => {
    const parser = new SseParser();
    expect(parser.push(chunk("last") + "data: [DONE]\n" + chunk("stray"))).toEqual([
      '{"choices":[{"delta":{"content":"last"}}]}',
    ]);
    expect(parser.done).toBe(true);
    expect(parser.push(chunk("more"))).toEqual([]);
  });

  it("flushes a trailing payload when the stream ends without a newline", () => {
    const parser = new SseParser();
    expect(parser.push("data: first\n" + "data: tail")).toEqual(["first"]);
    expect(parser.end()).toEqual(["tail"]);
    expect(new SseParser().end("data: only")).toEqual(["only"]);
  });

  it("skips comments, event names, blank lines and CRLF endings", () => {
    const parser = new SseParser();
    expect(parser.push(": keep-alive\r\nevent: ping\r\n\r\ndata: x\r\n")).toEqual(["x"]);
  });
});

describe("chatDelta", () => {
  it("extracts the delta text", () => {
    expect(chatDelta('{"choices":[{"delta":{"content":"hi"}}]}')).toBe("hi");
  });

  it("is null for empty, missing or malformed deltas", () => {
    expect(chatDelta('{"choices":[{"delta":{"content":""}}]}')).toBeNull();
    expect(chatDelta('{"choices":[{"delta":{"role":"assistant"}}]}')).toBeNull();
    expect(chatDelta('{"choices":[]}')).toBeNull();
    expect(chatDelta("null")).toBeNull();
    expect(chatDelta("{not json")).toBeNull();
  });
});
