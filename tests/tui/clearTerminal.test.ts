import { describe, expect, it } from "vitest";
import { clearTerminal } from "../../src/tui/clearTerminal.js";

function fakeStream(overrides: { isTTY?: boolean; write?: (data: string) => void } = {}) {
  const writes: string[] = [];
  const stream = {
    isTTY: overrides.isTTY ?? true,
    write: overrides.write ?? ((data: string) => writes.push(data)),
  } as unknown as NodeJS.WriteStream;
  return { stream, writes };
}

describe("clearTerminal", () => {
  it("writes ANSI erase-screen + home-cursor on a real TTY", () => {
    const { stream, writes } = fakeStream();
    clearTerminal(stream);
    expect(writes).toEqual(["\x1b[2J\x1b[3J\x1b[H"]);
  });

  it("is a no-op when stdout is not a TTY", () => {
    const { stream, writes } = fakeStream({ isTTY: false });
    clearTerminal(stream);
    expect(writes).toHaveLength(0);
  });

  it("is a no-op when stdout lacks a write function", () => {
    const stream = { isTTY: true } as unknown as NodeJS.WriteStream;
    clearTerminal(stream);
    // Should not throw.
    expect(true).toBe(true);
  });

  it("falls back to process.stdout when no argument is given", () => {
    // process.stdout may or may not be a TTY in test runners; the call itself
    // must not throw and should be safe regardless.
    expect(() => clearTerminal()).not.toThrow();
  });
});
