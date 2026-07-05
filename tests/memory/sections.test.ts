import { describe, expect, it } from "vitest";
import {
  appendToSection,
  findSection,
  normalizeForDedup,
  parseMarkdown,
  sectionHasNote,
  serializeMarkdown,
  setSection,
  type ParsedSection,
} from "../../src/memory/sections.js";

// ── parseMarkdown ────────────────────────────────────────────────────────────

describe("parseMarkdown", () => {
  it("returns empty preamble + no sections for blank input", () => {
    const doc = parseMarkdown("");
    expect(doc.preamble).toBe("");
    expect(doc.sections).toHaveLength(0);
  });

  it("captures a preamble with an H1 title and intro", () => {
    const doc = parseMarkdown("# Title\n\nIntro text.\n");
    expect(doc.preamble).toBe("# Title\n\nIntro text.");
    expect(doc.sections).toHaveLength(0);
  });

  it("parses a single section", () => {
    const doc = parseMarkdown("## Stack\nTypeScript, Node 22+.\n");
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0]!.title).toBe("Stack");
    expect(doc.sections[0]!.body).toBe("TypeScript, Node 22+.");
  });

  it("parses multiple sections in order", () => {
    const doc = parseMarkdown("# P\n\n## A\nalpha\n\n## B\nbeta\n");
    expect(doc.sections.map((s) => s.title)).toEqual(["A", "B"]);
    expect(doc.sections[0]!.body).toBe("alpha");
    expect(doc.sections[1]!.body).toBe("beta");
  });

  it("handles a preamble followed by sections", () => {
    const doc = parseMarkdown("# Project\n\nIntro.\n\n## Section\nbody\n");
    expect(doc.preamble).toBe("# Project\n\nIntro.");
    expect(doc.sections[0]!.title).toBe("Section");
    expect(doc.sections[0]!.body).toBe("body");
  });

  it("trims trailing blank lines from section bodies", () => {
    const doc = parseMarkdown("## S\nbody\n\n\n");
    expect(doc.sections[0]!.body).toBe("body");
  });
});

// ── serializeMarkdown ────────────────────────────────────────────────────────

describe("serializeMarkdown", () => {
  it("serializes empty doc to empty string", () => {
    expect(serializeMarkdown({ preamble: "", sections: [] })).toBe("");
  });

  it("round-trips preamble + sections", () => {
    const original = "# P\n\n## A\nalpha\n\n## B\nbeta\n";
    const doc = parseMarkdown(original);
    const out = serializeMarkdown(doc);
    const doc2 = parseMarkdown(out);
    expect(doc2.preamble).toBe("# P");
    expect(doc2.sections.map((s) => s.title)).toEqual(["A", "B"]);
    expect(doc2.sections[0]!.body).toBe("alpha");
    expect(doc2.sections[1]!.body).toBe("beta");
  });
});

// ── findSection ───────────────────────────────────────────────────────────────

describe("findSection", () => {
  it("finds a section case-insensitively", () => {
    const doc = parseMarkdown("## Key Points\nstuff\n");
    expect(findSection(doc, "key points")?.body).toBe("stuff");
    expect(findSection(doc, "KEY POINTS")?.body).toBe("stuff");
  });

  it("returns undefined for a missing section", () => {
    const doc = parseMarkdown("## A\nx\n");
    expect(findSection(doc, "B")).toBeUndefined();
  });
});

// ── setSection ───────────────────────────────────────────────────────────────

describe("setSection", () => {
  it("replaces an existing section's body", () => {
    const doc = parseMarkdown("## A\nold\n");
    setSection(doc, "A", "new");
    expect(findSection(doc, "A")?.body).toBe("new");
    expect(doc.sections).toHaveLength(1);
  });

  it("appends a new section when missing", () => {
    const doc = parseMarkdown("## A\nx\n");
    setSection(doc, "B", "y");
    expect(doc.sections.map((s) => s.title)).toEqual(["A", "B"]);
    expect(findSection(doc, "B")?.body).toBe("y");
  });
});

// ── appendToSection ──────────────────────────────────────────────────────────

describe("appendToSection", () => {
  it("creates a section if it does not exist", () => {
    const doc = parseMarkdown("");
    appendToSection(doc, "New", "- first");
    expect(doc.sections[0]!.title).toBe("New");
    expect(doc.sections[0]!.body).toBe("- first");
  });

  it("appends a line to an existing section body", () => {
    const doc = parseMarkdown("## S\n- first\n");
    appendToSection(doc, "S", "- second");
    expect(findSection(doc, "S")?.body).toBe("- first\n- second");
  });
});

// ── dedup helpers ────────────────────────────────────────────────────────────

describe("normalizeForDedup", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeForDedup("  Hello   World  ")).toBe("hello world");
  });

  it("trims to empty for whitespace-only", () => {
    expect(normalizeForDedup("   \n\t  ")).toBe("");
  });
});

describe("sectionHasNote", () => {
  const section: ParsedSection = {
    title: "X",
    body: "- [2026-01-01] The bwrap sandbox masks /tmp workspaces.",
  };

  it("detects an exact restatement", () => {
    expect(sectionHasNote(section, "The bwrap sandbox masks /tmp workspaces.")).toBe(true);
  });

  it("detects a substring note", () => {
    expect(sectionHasNote(section, "bwrap sandbox masks")).toBe(true);
  });

  it("returns false for a novel note", () => {
    expect(sectionHasNote(section, "node lives at ~/.local/bin/node")).toBe(false);
  });

  it("returns false for an empty note", () => {
    expect(sectionHasNote(section, "   ")).toBe(false);
  });
});
