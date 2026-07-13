import { describe, expect, it } from "vitest";
import { serializeDraft, yamlString } from "../../src/agent/serialize.js";

describe("serializeDraft", () => {
  it("emits YAML frontmatter + body for required fields", () => {
    const out = serializeDraft({
      name: "builder",
      description: "Builds things",
      systemPrompt: "You build things.",
      model: "qwen3.5:9b",
      provider: "ollama",
      permissionMode: "default",
    });
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("name: builder");
    expect(out).toContain("description: Builds things");
    expect(out).toContain('model: "qwen3.5:9b"');
    expect(out).toContain("provider: ollama");
    expect(out).toContain("permissionMode: default");
    expect(out).toContain("\n---\n"); // closing frontmatter fence
    expect(out).toContain("You build things.");
  });

  it("rejects a missing model", () => {
    expect(() =>
      serializeDraft({
        name: "x",
        description: "d",
        systemPrompt: "s",
        permissionMode: "default",
      }),
    ).toThrow(/concrete model id/);
  });

  it("rejects a missing provider", () => {
    expect(() =>
      serializeDraft({
        name: "x",
        description: "d",
        systemPrompt: "s",
        model: "qwen3.5:9b",
        permissionMode: "default",
      }),
    ).toThrow(/configured provider name/);
  });

  it("omits optional fields when not provided", () => {
    const out = serializeDraft({
      name: "x",
      description: "d",
      systemPrompt: "s",
      model: "qwen3.5:9b",
      provider: "ollama",
      permissionMode: "default",
    });
    expect(out).not.toContain("tools:");
    expect(out).not.toContain("delegateAllowlist:");
    expect(out).not.toContain("mcpServers:");
    expect(out).not.toContain("maxTurns");
  });

  it("serializes arrays as YAML block lists", () => {
    const out = serializeDraft({
      name: "x",
      description: "d",
      systemPrompt: "s",
      model: "qwen3.5:9b",
      provider: "ollama",
      permissionMode: "default",
      tools: ["write_file", "run_command"],
      delegateAllowlist: ["builder", "tester"],
      mcpServers: ["github"],
    });
    expect(out).toContain("tools:\n  - write_file\n  - run_command");
    expect(out).toContain("delegateAllowlist:\n  - builder\n  - tester");
    expect(out).toContain("mcpServers:\n  - github");
  });

  it("serializes maxTurns as a number", () => {
    const out = serializeDraft({
      name: "x",
      description: "d",
      systemPrompt: "s",
      model: "qwen3.5:9b",
      provider: "ollama",
      permissionMode: "default",
      maxTurns: 25,
    });
    expect(out).toContain("maxTurns: 25");
  });

  it("does not emit tools block for an empty array", () => {
    const out = serializeDraft({
      name: "x",
      description: "d",
      systemPrompt: "s",
      model: "qwen3.5:9b",
      provider: "ollama",
      permissionMode: "default",
      tools: [],
    });
    expect(out).not.toContain("tools:");
  });

  it("trims trailing whitespace on the system prompt", () => {
    const out = serializeDraft({
      name: "x",
      description: "d",
      systemPrompt: "  body with spaces  \n\n",
      model: "qwen3.5:9b",
      provider: "ollama",
      permissionMode: "default",
    });
    expect(out).not.toMatch(/\n\n\n$/); // no triple trailing newline
    expect(out.endsWith("\n")).toBe(true);
  });

  it("quotes YAML scalars with special characters", () => {
    const out = serializeDraft({
      name: "x",
      description: "does a: b and # c",
      systemPrompt: "s",
      model: "qwen3.5:9b",
      provider: "ollama",
      permissionMode: "default",
    });
    // The colon/hash in the description forces quoting.
    expect(out).toContain('description: "does a: b and # c"');
  });
});

describe("yamlString", () => {
  it("leaves plain scalars unquoted", () => {
    expect(yamlString("plain-value")).toBe("plain-value");
    expect(yamlString("frontier")).toBe("frontier");
  });

  it.each([
    [":", "colon"],
    ["#", "hash"],
    ["[", "bracket"],
    ["a, b", "comma"],
    ["100%", "percent"],
    ["a|b", "pipe"],
  ])("quotes scalars containing special char %s (%s)", (special) => {
    expect(yamlString(`x${special}y`)).toMatch(/^".*"$/);
  });

  it("escapes embedded double quotes", () => {
    expect(yamlString('say "hi"')).toBe('"say \\"hi\\""');
  });

  it("does not quote a bare backslash (not a YAML special char here)", () => {
    expect(yamlString("a\\b")).toBe("a\\b");
  });

  it("escapes backslashes when another char forces quoting", () => {
    // Input (4 chars): a \ " b. The " forces quoting; the \ must be doubled.
    const out = yamlString('a\\"b');
    expect(out.startsWith('"')).toBe(true);
    expect(out.endsWith('"')).toBe(true);
    // Backslash doubled to \\, and the embedded " escaped to \".
    expect(out).toContain("\\\\");
    expect(out).toContain('\\"');
  });

  it("quotes multi-line strings", () => {
    expect(yamlString("line1\nline2")).toBe('"line1\nline2"');
  });
});
