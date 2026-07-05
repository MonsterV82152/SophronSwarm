/**
 * Markdown section utilities — parse and edit `## Section`-structured markdown.
 *
 * Used by both the shared memory store and per-agent memory store to read,
 * write, and append to named sections without corrupting surrounding content.
 *
 * Section model: a markdown document is a preamble (everything before the
 * first `## ` header — includes any `# H1` title) followed by ordered
 * sections, each identified by a `## Title` header. A section's body is
 * everything up to the next `## ` header.
 *
 * See docs/PROJECT_OVERVIEW.md §5.2/§5.3 (memory tiers).
 */

export interface ParsedSection {
  title: string;
  body: string;
}

export interface ParsedMarkdown {
  /** Text before the first `## ` header (includes any `# H1`). */
  preamble: string;
  /** Sections in document order. */
  sections: ParsedSection[];
}

const SECTION_RE = /^##\s+(.+?)\s*$/;

/**
 * Parse markdown into a preamble + ordered `## ` sections.
 * Trailing whitespace is trimmed from the preamble and each section body.
 */
export function parseMarkdown(raw: string): ParsedMarkdown {
  const lines = raw.split("\n");
  const preamble: string[] = [];
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;
  let body: string[] = [];

  for (const line of lines) {
    const m = line.match(SECTION_RE);
    if (m) {
      if (current) {
        current.body = body.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
        sections.push(current);
      }
      current = { title: m[1]!.trim(), body: "" };
      body = [];
    } else if (current) {
      body.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) {
    current.body = body.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
    sections.push(current);
  }

  return {
    preamble: preamble.join("\n").replace(/\n+$/, ""),
    sections,
  };
}

/** Serialize a parsed document back to markdown (blank line between blocks). */
export function serializeMarkdown(doc: ParsedMarkdown): string {
  const parts: string[] = [];
  if (doc.preamble.trim()) parts.push(doc.preamble.trim());
  for (const s of doc.sections) {
    parts.push(`## ${s.title}`);
    if (s.body.trim()) parts.push(s.body.trim());
  }
  return parts.length > 0 ? parts.join("\n\n") + "\n" : "";
}

/** Find a section by title (case-insensitive). Undefined if not found. */
export function findSection(doc: ParsedMarkdown, title: string): ParsedSection | undefined {
  const lower = title.toLowerCase();
  return doc.sections.find((s) => s.title.toLowerCase() === lower);
}

/**
 * Replace a section's body, or append a new section at the end if missing.
 * Mutates and returns the doc.
 */
export function setSection(doc: ParsedMarkdown, title: string, body: string): ParsedMarkdown {
  const existing = findSection(doc, title);
  if (existing) {
    existing.body = body;
  } else {
    doc.sections.push({ title, body });
  }
  return doc;
}

/**
 * Append a line to a section's body (creates the section if missing).
 * Mutates and returns the doc.
 */
export function appendToSection(doc: ParsedMarkdown, title: string, line: string): ParsedMarkdown {
  const existing = findSection(doc, title);
  if (existing) {
    const trimmed = existing.body.replace(/\n+$/, "");
    existing.body = trimmed ? `${trimmed}\n${line}` : line;
  } else {
    doc.sections.push({ title, body: line });
  }
  return doc;
}

/** Lowercase + collapse whitespace for dedup comparison. */
export function normalizeForDedup(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Check whether a note (normalized) already appears in a section's body.
 * Matches as a substring so a short re-statement of an existing note is caught.
 */
export function sectionHasNote(section: ParsedSection, note: string): boolean {
  const norm = normalizeForDedup(note);
  if (!norm) return false;
  for (const line of section.body.split("\n")) {
    if (normalizeForDedup(line).includes(norm)) return true;
  }
  return false;
}
