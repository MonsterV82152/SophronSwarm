// Quick verification that checkpoints persisted for the smoke-test run.
// Run: npx tsx scripts/verify-checkpoints.ts <runId>
import { Checkpointer } from "../src/state/checkpointer.js";

const runId = process.argv[2];
if (!runId) {
  console.error("usage: npx tsx scripts/verify-checkpoints.ts <runId>");
  process.exit(1);
}

const cp = new Checkpointer(".sophron/checkpoint.db");
const thread = cp.loadThread(runId);
console.log(`snapshots for ${runId}: ${thread.length}`);
for (const s of thread) {
  console.log(`  seq=${s.seq} turn=${s.turn} status=${s.status} msgs=${s.messages.length}`);
}
cp.close();
