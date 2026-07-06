import { describe, expect, it } from "vitest";
import { ApprovalsQueue, gateDecisionFor } from "../../src/tui/approvals.js";

describe("ApprovalsQueue", () => {
  it("starts empty", () => {
    const q = new ApprovalsQueue();
    expect(q.size).toBe(0);
    expect(q.pending()).toEqual([]);
  });

  it("enqueues an item and returns an id", () => {
    const q = new ApprovalsQueue();
    const id = q.enqueue({ agent: "builder", tool: "run_command", args: { cmd: "rm -rf x" }, runId: "r1" });
    expect(id).toBeTruthy();
    expect(q.size).toBe(1);
  });

  it("pending returns items oldest-first", () => {
    const q = new ApprovalsQueue();
    const id1 = q.enqueue({ agent: "a", tool: "t", args: {}, runId: "r1" });
    const id2 = q.enqueue({ agent: "b", tool: "t", args: {}, runId: "r2" });
    const pending = q.pending();
    expect(pending).toHaveLength(2);
    expect(pending[0]!.id).toBe(id1);
    expect(pending[1]!.id).toBe(id2);
  });

  it("resolve removes the item and returns the decision", () => {
    const q = new ApprovalsQueue();
    const id = q.enqueue({ agent: "builder", tool: "run_command", args: {}, runId: "r1" });
    const result = q.resolve(id, "allow");
    expect(result?.decision).toBe("allow");
    expect(result?.item.agent).toBe("builder");
    expect(q.size).toBe(0);
  });

  it("resolve returns null for an unknown id", () => {
    const q = new ApprovalsQueue();
    expect(q.resolve("nonexistent", "allow")).toBeNull();
  });

  it("resolve works with the short id prefix", () => {
    const q = new ApprovalsQueue();
    const id = q.enqueue({ agent: "a", tool: "t", args: {}, runId: "r1" });
    const shortId = id.slice(0, 8);
    const result = q.resolve(shortId, "deny");
    expect(result?.decision).toBe("deny");
    expect(q.size).toBe(0);
  });

  it("resolve is case-insensitive on the id", () => {
    const q = new ApprovalsQueue();
    const id = q.enqueue({ agent: "a", tool: "t", args: {}, runId: "r1" });
    const result = q.resolve(id.toUpperCase(), "allow");
    expect(result?.item.id).toBe(id);
  });

  it("items carry a shortId (first 8 chars)", () => {
    const q = new ApprovalsQueue();
    const id = q.enqueue({ agent: "a", tool: "t", args: {}, runId: "r1" });
    expect(q.pending()[0]!.shortId).toBe(id.slice(0, 8));
    expect(q.pending()[0]!.shortId).toHaveLength(8);
  });
});

describe("gateDecisionFor", () => {
  const q = () => new ApprovalsQueue();

  it("allows read-only tools", () => {
    expect(gateDecisionFor("read_file", { name: "a", permissionMode: "default" }, q(), { runId: "r1" }, {})).toBe("allow");
    expect(gateDecisionFor("list_dir", { name: "a", permissionMode: "plan" }, q(), { runId: "r1" }, {})).toBe("allow");
  });

  it("denies mutating tools in plan mode", () => {
    expect(gateDecisionFor("write_file", { name: "a", permissionMode: "plan" }, q(), { runId: "r1" }, {})).toBe("deny");
    expect(gateDecisionFor("run_command", { name: "a", permissionMode: "plan" }, q(), { runId: "r1" }, {})).toBe("deny");
  });

  it("enqueues + returns prompt for mutating tools in default mode", () => {
    const queue = q();
    const decision = gateDecisionFor("run_command", { name: "a", permissionMode: "default" }, queue, { runId: "r1" }, { cmd: "ls" });
    expect(decision).toBe("prompt");
    expect(queue.size).toBe(1);
    expect(queue.pending()[0]!.tool).toBe("run_command");
  });

  it("allows mutating tools in accept-edits / auto / full-auto", () => {
    for (const mode of ["accept-edits", "auto", "full-auto"]) {
      expect(gateDecisionFor("write_file", { name: "a", permissionMode: mode }, q(), { runId: "r1" }, {})).toBe("allow");
    }
  });

  it("allows non-mutating, non-readonly tools (delegate, remember, etc.)", () => {
    expect(gateDecisionFor("delegate", { name: "a", permissionMode: "default" }, q(), { runId: "r1" }, {})).toBe("allow");
    expect(gateDecisionFor("remember", { name: "a", permissionMode: "default" }, q(), { runId: "r1" }, {})).toBe("allow");
  });
});
