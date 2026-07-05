import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedMemoryStore, SHARED_FILES, fileToTitle } from "../../src/memory/sharedStore.js";

describe("fileToTitle", () => {
  it("converts a snake-case filename to a title", () => {
    expect(fileToTitle("CURRENT_CHECKPOINT.md")).toBe("Current Checkpoint");
  });
  it("converts a single-word filename", () => {
    expect(fileToTitle("OVERVIEW.md")).toBe("Overview");
  });
});

describe("SharedMemoryStore", () => {
  let dir: string;
  let store: SharedMemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sophron-shared-"));
    store = new SharedMemoryStore(join(dir, ".sophron", "shared"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("read returns empty string for a missing file", () => {
    expect(store.read("NOPE.md")).toBe("");
    expect(store.exists("NOPE.md")).toBe(false);
  });

  it("write + read round-trips", () => {
    store.write(SHARED_FILES.OVERVIEW, "# Project\n\nBody.\n");
    expect(store.exists(SHARED_FILES.OVERVIEW)).toBe(true);
    expect(store.read(SHARED_FILES.OVERVIEW)).toBe("# Project\n\nBody.\n");
  });

  it("write creates the nested directory", () => {
    store.write(SHARED_FILES.OVERVIEW, "x");
    expect(existsSync(store.dir)).toBe(true);
  });

  it("writeSection creates a section in a new file", () => {
    store.writeSection(SHARED_FILES.OVERVIEW, "Stack", "TypeScript.");
    const onDisk = readFileSync(store.path(SHARED_FILES.OVERVIEW), "utf8");
    expect(onDisk).toContain("## Stack");
    expect(onDisk).toContain("TypeScript.");
  });

  it("writeSection replaces an existing section body", () => {
    store.write(SHARED_FILES.OVERVIEW, "## Stack\nold\n");
    store.writeSection(SHARED_FILES.OVERVIEW, "Stack", "new");
    expect(store.readSection(SHARED_FILES.OVERVIEW, "Stack")).toBe("new");
  });

  it("writeSection preserves other sections", () => {
    store.write(SHARED_FILES.OVERVIEW, "# P\n\n## Stack\nold stack\n\n## Constraints\ncon\n");
    store.writeSection(SHARED_FILES.OVERVIEW, "Stack", "new stack");
    expect(store.readSection(SHARED_FILES.OVERVIEW, "Constraints")).toBe("con");
    expect(store.readSection(SHARED_FILES.OVERVIEW, "Stack")).toBe("new stack");
  });

  it("readSection returns empty for a missing section", () => {
    store.write(SHARED_FILES.OVERVIEW, "## Stack\nx\n");
    expect(store.readSection(SHARED_FILES.OVERVIEW, "Missing")).toBe("");
  });

  it("appendToSection creates and appends", () => {
    store.appendToSection(SHARED_FILES.OVERVIEW, "Notes", "- first");
    store.appendToSection(SHARED_FILES.OVERVIEW, "Notes", "- second");
    expect(store.readSection(SHARED_FILES.OVERVIEW, "Notes")).toBe("- first\n- second");
  });

  it("listFiles returns only the .md files present", () => {
    store.write(SHARED_FILES.OVERVIEW, "x");
    store.write(SHARED_FILES.CHECKPOINTS, "y");
    const files = store.listFiles();
    expect(files).toContain(SHARED_FILES.OVERVIEW);
    expect(files).toContain(SHARED_FILES.CHECKPOINTS);
    expect(files).not.toContain(SHARED_FILES.CURRENT_CHECKPOINT);
  });

  describe("toInjectionMap", () => {
    it("returns an empty map when no files exist", () => {
      expect(store.toInjectionMap().size).toBe(0);
    });

    it("includes only non-empty files, keyed by title", () => {
      store.write(SHARED_FILES.OVERVIEW, "# Overview\n\nReal content.\n");
      store.write(SHARED_FILES.CHECKPOINTS, "   \n"); // whitespace-only
      const map = store.toInjectionMap();
      expect(map.size).toBe(1);
      expect(map.get("Overview")).toContain("Real content.");
      expect(map.has("Checkpoints")).toBe(false);
    });
  });
});
