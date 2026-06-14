// Autonomous parameter sweep: runs the headless eval across a grid of AI tuning params, parses each
// run's composite score, and reports the ranked results + the best combo. The "search" half of the
// run→eval→fix loop. Run: node tools/sweep.mjs
import { execFileSync } from "node:child_process";

// grid of GamePlay overrides (PARAM_<key>) to search
const GRID = {
  maxLateralImpulse: [1.5, 2, 2.5],  // fine-tune around best (2)
  aiSteerDivisor: [8, 10, 12],        // fine-tune around best (10)
  aiCornerLiftSpeed: [60, 999],       // try corner lifting now that grip is lower
};

const keys = Object.keys(GRID);
function* combos(i = 0, acc = {}) {
  if (i === keys.length) { yield { ...acc }; return; }
  for (const v of GRID[keys[i]]) yield* combos(i + 1, { ...acc, [keys[i]]: v });
}

function runEval(overrides) {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(overrides)) env[`PARAM_${k}`] = String(v);
  const out = execFileSync("npx", ["tsx", "tools/eval.ts"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out);
}

const results = [];
for (const c of combos()) {
  const r = runEval(c);
  results.push({ params: c, score: r.score, finish: r.finishedCount, stuck: r.totalStuckEvents, walls: r.totalWallContacts, avgFinish: r.avgFinishTime, spread: r.fieldSpread });
  process.stdout.write(`. `);
}
process.stdout.write("\n");

results.sort((a, b) => b.score - a.score);
console.log("\nTop 8 combos by score:");
for (const r of results.slice(0, 8)) {
  console.log(`  score ${r.score.toFixed(1)}  finish ${r.finish}/4  stuck ${r.stuck}  walls ${r.walls}  avgFin ${r.avgFinish}  spread ${r.spread}  ::  ${JSON.stringify(r.params)}`);
}
console.log("\nWorst 3:");
for (const r of results.slice(-3)) {
  console.log(`  score ${r.score.toFixed(1)}  walls ${r.walls}  ::  ${JSON.stringify(r.params)}`);
}
console.log(`\nBEST: ${JSON.stringify(results[0].params)}  → score ${results[0].score.toFixed(1)}`);
