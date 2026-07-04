// List all checkpointed threads and their snapshot counts.
import { Checkpointer } from "../src/state/checkpointer.js";

const cp = new Checkpointer(".sophron/checkpoint.db");
const cpAny = cp as unknown as { db: { prepare: (q: string) => { all: () => unknown[] } } };
const rows = cpAny.db
  .prepare(
    "SELECT thread_id, run_id, COUNT(*) as n, MIN(seq) as first, MAX(seq) as last FROM checkpoints GROUP BY thread_id ORDER BY first DESC",
  )
  .all() as { thread_id: string; run_id: string; n: number; first: number; last: number }[];

console.log(`threads: ${rows.length}`);
for (const r of rows) {
  console.log(`  thread=${r.thread_id.slice(0, 8)} run=${r.run_id.slice(0, 8)} snapshots=${r.n} (seq ${r.first}–${r.last})`);
}
cp.close();
