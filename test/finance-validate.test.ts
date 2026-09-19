import { describe, expect, it } from "vitest";
import { validateFinanceGraph } from "../src/lib/finance-validate";
import type { FinEdge, FinanceTable, RawFinanceSignals } from "../src/lib/finance-types";

const SENTENCE = "Total revenue for the quarter was $1.2 billion, up from a year earlier.";

function signals(partial: Partial<RawFinanceSignals> = {}): RawFinanceSignals {
  return {
    url: "https://example.com/earnings",
    title: "Q3 results",
    blocks: [{ id: "b1", text: SENTENCE }],
    tables: [],
    currencyHints: ["$"],
    truncated: [],
    ...partial,
  };
}

function table(rows: string[][], scaleNote = "", id = "t1"): FinanceTable {
  return { id, caption: "Results by segment", scaleNote, rows };
}

interface RawNode {
  id: string;
  label: string;
  rawAmount: string;
  sourceId: string;
  sourceText: string;
  period?: string;
  amount?: number;
}

function node(partial: Partial<RawNode> & { id: string; rawAmount: string; sourceText: string }): RawNode {
  return { label: partial.id, sourceId: "b1", ...partial };
}

function cellNode(id: string, rawAmount: string, label = id): RawNode {
  return { id, label, rawAmount, sourceId: "t1", sourceText: rawAmount };
}

function edge(from: string, to: string, kind: FinEdge["kind"] = "composition"): FinEdge {
  return { from, to, kind };
}

describe("malformed model output", () => {
  it("throws rather than half-trusting a response that is not a graph", () => {
    expect(() => validateFinanceGraph(null, signals())).toThrow();
    expect(() => validateFinanceGraph({}, signals())).toThrow();
    expect(() => validateFinanceGraph({ nodes: {} }, signals())).toThrow();
    expect(() => validateFinanceGraph('{"nodes":[]}', signals())).toThrow();
    expect(() => validateFinanceGraph({ nodes: [], edges: "a,b" }, signals())).toThrow();
  });

  it("takes a graph with no edges, and drops malformed nodes inside a good response", () => {
    const result = validateFinanceGraph({ nodes: [null, { id: "n1" }, 7] }, signals());
    expect(result.graph.nodes).toEqual([]);
    expect(result.dropped).toBe(3);
    expect(result.graph.notChecked).toEqual([]);
  });
});

describe("a node has to come from the page", () => {
  it("keeps a node whose sentence is really there", () => {
    const result = validateFinanceGraph(
      { nodes: [node({ id: "rev", label: "Total revenue", rawAmount: "$1.2 billion", sourceText: SENTENCE })] },
      signals(),
    );
    expect(result.dropped).toBe(0);
    expect(result.graph.nodes[0].amount).toBe(1.2e9);
    expect(result.graph.nodes[0].currency).toBe("$");
  });

  it("drops a node whose sourceText is not on the page", () => {
    const result = validateFinanceGraph(
      {
        nodes: [
          node({
            id: "rev",
            rawAmount: "$4.2 billion",
            sourceText: "Total revenue for the quarter was $4.2 billion, up from a year earlier.",
          }),
        ],
      },
      signals(),
    );
    expect(result.graph.nodes).toEqual([]);
    expect(result.dropped).toBe(1);
  });

  it("drops a node whose figure is not inside its own sentence", () => {
    const result = validateFinanceGraph(
      { nodes: [node({ id: "rev", rawAmount: "$4.2 billion", sourceText: SENTENCE })] },
      signals(),
    );
    expect(result.graph.nodes).toEqual([]);
    expect(result.dropped).toBe(1);
  });

  it("drops a node whose sourceId names a block that does not exist", () => {
    const result = validateFinanceGraph(
      { nodes: [node({ id: "rev", rawAmount: "$1.2 billion", sourceText: SENTENCE, sourceId: "b9" })] },
      signals(),
    );
    expect(result.dropped).toBe(1);
  });

  it("drops a quote padded with words the page never had beside it", () => {
    const result = validateFinanceGraph(
      { nodes: [node({ id: "rev", rawAmount: "$1.2 billion", sourceText: `As reported, ${SENTENCE}` })] },
      signals(),
    );
    expect(result.dropped).toBe(1);
  });

  it("drops a prose span too short to point at one place on the page", () => {
    const result = validateFinanceGraph(
      { nodes: [node({ id: "rev", rawAmount: "$1.2 billion", sourceText: "was $1.2 billion, up from" })] },
      signals(),
    );
    expect(result.dropped).toBe(1);
  });

  it("drops the second node claiming an id already used", () => {
    const one = node({ id: "rev", rawAmount: "$1.2 billion", sourceText: SENTENCE });
    const result = validateFinanceGraph({ nodes: [one, { ...one, label: "Revenue again" }] }, signals());
    expect(result.graph.nodes).toHaveLength(1);
    expect(result.dropped).toBe(1);
  });

  it("takes the amount from the page, never from the model", () => {
    const result = validateFinanceGraph(
      { nodes: [node({ id: "rev", rawAmount: "$1.2 billion", sourceText: SENTENCE, amount: 7 })] },
      signals(),
    );
    expect(result.graph.nodes[0].amount).toBe(1.2e9);
  });
});

describe("table cells and scale headers", () => {
  const scaled = signals({
    blocks: [],
    tables: [table([["Total revenue", "1,200"], ["Research and development", "(3,410)"], ["Gross margin", "40%"]], "(in millions)")],
  });

  it("applies the table's scale note to a bare cell", () => {
    const result = validateFinanceGraph({ nodes: [cellNode("rev", "1,200", "Total revenue")] }, scaled);
    expect(result.graph.nodes[0].amount).toBe(1.2e9);
  });

  it("scales an accounting negative the same way", () => {
    const result = validateFinanceGraph({ nodes: [cellNode("rd", "(3,410)", "R&D")] }, scaled);
    expect(result.graph.nodes[0].amount).toBe(-3.41e9);
  });

  it("does not scale a cell that names its own magnitude", () => {
    const own = signals({
      blocks: [],
      tables: [table([["Total revenue", "$1.2 billion"]], "(in millions)")],
    });
    const result = validateFinanceGraph({ nodes: [cellNode("rev", "$1.2 billion", "Total revenue")] }, own);
    expect(result.graph.nodes[0].amount).toBe(1.2e9);
  });

  it("accepts a whole row as a source span", () => {
    const result = validateFinanceGraph(
      { nodes: [{ id: "rd", label: "R&D", rawAmount: "(3,410)", sourceId: "t1", sourceText: "Research and development (3,410)" }] },
      scaled,
    );
    expect(result.dropped).toBe(0);
    expect(result.graph.nodes[0].amount).toBe(-3.41e9);
  });
});

describe("arithmetic", () => {
  const sums = signals({
    blocks: [],
    tables: [table([["Total", "1,000"], ["North", "600"], ["South", "400"], ["Rest", "350"], ["Nearly", "380"], ["Share", "40%"]])],
  });

  function check(children: string[]): ReturnType<typeof validateFinanceGraph> {
    return validateFinanceGraph(
      {
        nodes: [cellNode("total", "1,000", "Total"), ...children.map((raw, i) => cellNode(`c${i}`, raw))],
        edges: children.map((_, i) => edge("total", `c${i}`)),
      },
      sums,
    );
  }

  it("passes children that add up to their parent", () => {
    const result = check(["600", "400"]);
    expect(result.mismatches).toBe(0);
    expect(result.graph.nodes[0].warn).toBeUndefined();
  });

  it("flags a parent its children miss by more than 2%, and keeps every node", () => {
    const result = check(["600", "350"]);
    expect(result.mismatches).toBe(1);
    expect(result.graph.nodes).toHaveLength(3);
    expect(result.graph.nodes[0].warn).toBe("children_sum_mismatch");
    expect(result.dropped).toBe(0);
  });

  it("lets a gap inside the 2% tolerance pass", () => {
    const result = check(["600", "380"]);
    expect(result.mismatches).toBe(0);
    expect(result.graph.nodes[0].warn).toBeUndefined();
  });

  it("never adds a percentage into a total", () => {
    const result = check(["600", "400", "40%"]);
    expect(result.mismatches).toBe(0);
    expect(result.graph.nodes).toHaveLength(3);
    expect(result.dropped).toBe(1);
    expect(result.graph.notChecked.some((line) => line.includes("percentage"))).toBe(true);
  });

  it("does not check a single listed part against its parent", () => {
    const result = check(["600"]);
    expect(result.mismatches).toBe(0);
    expect(result.graph.nodes[0].warn).toBeUndefined();
  });

  it("refuses to add amounts in different currencies, and says so", () => {
    const mixed = signals({
      blocks: [],
      tables: [table([["Total", "$1,000"], ["North", "$600"], ["Europe", "€400"]])],
    });
    const result = validateFinanceGraph(
      {
        nodes: [cellNode("total", "$1,000", "Total"), cellNode("na", "$600"), cellNode("eu", "€400")],
        edges: [edge("total", "na"), edge("total", "eu")],
      },
      mixed,
    );
    expect(result.mismatches).toBe(0);
    expect(result.graph.nodes[0].warn).toBeUndefined();
    expect(result.graph.notChecked.some((line) => line.includes("different currencies cannot be added"))).toBe(true);
  });

  it("refuses to add parts from different periods, and says so", () => {
    const result = validateFinanceGraph(
      {
        nodes: [
          { ...cellNode("total", "1,000", "Total"), period: "FY2025" },
          { ...cellNode("c0", "600"), period: "FY2025" },
          { ...cellNode("c1", "400"), period: "FY2024" },
        ],
        edges: [edge("total", "c0"), edge("total", "c1")],
      },
      sums,
    );
    expect(result.mismatches).toBe(0);
    expect(result.graph.notChecked.some((line) => line.includes("different periods"))).toBe(true);
  });
});

describe("graph shape", () => {
  const shaped = signals({
    blocks: [],
    tables: [table([["Total", "1,000"], ["North", "600"], ["South", "400"]])],
  });
  const nodes = [cellNode("total", "1,000", "Total"), cellNode("na", "600"), cellNode("eu", "400")];

  it("drops an edge pointing at an id that does not exist", () => {
    const result = validateFinanceGraph({ nodes, edges: [edge("total", "na"), edge("total", "ghost")] }, shaped);
    expect(result.graph.edges).toEqual([edge("total", "na")]);
    expect(result.graph.notChecked.some((line) => line.includes("did not survive checking"))).toBe(true);
  });

  it("drops the edge that closes a cycle, and keeps the figures", () => {
    const result = validateFinanceGraph(
      { nodes, edges: [edge("total", "na"), edge("na", "eu"), edge("eu", "total")] },
      shaped,
    );
    expect(result.graph.edges).toEqual([edge("total", "na"), edge("na", "eu")]);
    expect(result.graph.nodes).toHaveLength(3);
    expect(result.graph.notChecked.some((line) => line.includes("cannot be part of itself"))).toBe(true);
  });

  it("drops an edge pointing at its own node", () => {
    const result = validateFinanceGraph({ nodes, edges: [edge("total", "total")] }, shaped);
    expect(result.graph.edges).toEqual([]);
  });

  it("drops a malformed or duplicated edge without comment", () => {
    const result = validateFinanceGraph(
      { nodes, edges: [edge("total", "na"), edge("total", "na"), { from: "total", to: "eu", kind: "sideways" }, null] },
      shaped,
    );
    expect(result.graph.edges).toEqual([edge("total", "na")]);
  });
});

describe("what could not be checked", () => {
  it("names the part of the page that was never read", () => {
    const result = validateFinanceGraph({ nodes: [] }, signals({ truncated: ["tables past the first 20"] }));
    expect(result.graph.notChecked[0]).toContain("tables past the first 20");
  });

  it("says when a figure carries no currency of its own", () => {
    const bare = signals({ blocks: [], tables: [table([["Total", "1,000"]])] });
    const result = validateFinanceGraph({ nodes: [cellNode("total", "1,000", "Total")] }, bare);
    expect(result.graph.currency).toBe("$");
    expect(result.graph.notChecked.some((line) => line.includes("printed with no currency"))).toBe(true);
    expect(result.graph.notChecked.some((line) => line.includes("which dollar"))).toBe(true);
  });

  it("stops saying which dollar once the page says which", () => {
    const named = signals({ currencyHints: ["$", "CAD"] });
    const result = validateFinanceGraph(
      { nodes: [node({ id: "rev", rawAmount: "$1.2 billion", sourceText: SENTENCE })] },
      named,
    );
    expect(result.graph.currency).toBe("CAD");
    expect(result.graph.notChecked.some((line) => line.includes("which dollar"))).toBe(false);
  });
});
