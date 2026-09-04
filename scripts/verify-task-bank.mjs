/**
 * The acceptance test for the Interview 2 task bank.
 *
 * Every variant, across many seeds, must satisfy five properties:
 *
 *   1. A perfect submission scores exactly 100. If it does not, the checker and
 *      the answer key disagree, and a candidate who did everything right would
 *      be marked down for it.
 *   2. An empty submission scores 0 — never negative, never NaN.
 *   3. "Flag everything" scores poorly. The false-positive trap is the whole
 *      discriminator; if spraying flags scored well the task would measure
 *      nothing.
 *   4. No accept-set is empty. An item with no right answer is unanswerable,
 *      and that is exactly the defect that put 17 of 100 English-test grammar
 *      items in dispute and would have wrongly rejected 23 of 45 candidates.
 *   5. The BRIEF contains no answer. The served payload is what reaches the
 *      browser; if the key leaks into it, every other defence is decoration.
 *
 *   node scripts/verify-task-bank.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "taskbank-"));
// `--paths` is rejected on the command line, so the compile runs from a
// throwaway tsconfig that resolves the "@/lib/*" aliases the sources use.
const tsconfigPath = join(dir, "tsconfig.verify.json");
const { writeFileSync: writeCfg } = await import("node:fs");
writeCfg(
  tsconfigPath,
  JSON.stringify({
    compilerOptions: {
      outDir: dir,
      module: "es2022",
      target: "es2022",
      moduleResolution: "bundler",
      skipLibCheck: true,
      baseUrl: process.cwd(),
      paths: { "@/lib/*": ["./src/lib/*"] },
    },
    files: [
      join(process.cwd(), "src/lib/taskBank.ts"),
      join(process.cwd(), "src/lib/taskCheck.ts"),
      join(process.cwd(), "src/lib/taskSeed.ts"),
      join(process.cwd(), "src/lib/roleTask.ts"),
    ],
  })
);
try {
  execFileSync("npx", ["tsc", "-p", tsconfigPath], { cwd: process.cwd(), stdio: "pipe" });
} catch (err) {
  console.error("tsc failed:\n" + (err.stdout?.toString() || err.stderr?.toString() || err.message));
  process.exit(1);
}

// tsc emits bare "@/lib/x" specifiers; rewrite them to relative paths so Node
// can load the output without a bundler.
const { readdirSync, readFileSync, writeFileSync } = await import("node:fs");
for (const f of readdirSync(dir)) {
  if (!f.endsWith(".js")) continue;
  const p = join(dir, f);
  writeFileSync(p, readFileSync(p, "utf8").replace(/from "@\/lib\/([^"]+)"/g, 'from "./$1.js"'));
}

const { buildTask, ALL_VARIANTS } = await import(join(dir, "taskBank.js"));
const { scoreTask } = await import(join(dir, "taskCheck.js"));

const SEEDS = ["ABCD2345EFGH", "ZZZZ9999YYYY", "M7K2P9Q4R6TV", "23456789ABCD", "XYZWVTQPNMKJ"];
let failures = 0;
const fail = (msg) => { failures++; console.log(`  ✗ ${msg}`); };

/** Build the submission a candidate who got everything right would send. */
function perfectSubmission(keys) {
  const s = {};
  for (const key of keys) {
    if (key.type === "email_extract") {
      for (const f of key.fields) s[f.id] = f.accept[0];
    } else if (key.type === "queue_sort") {
      for (const it of key.items) s[it.id] = it.accept[0];
    } else if (key.type === "row_check") {
      for (const r of key.rows) {
        s[r.id] = r.defect
          ? { flagged: true, corrected: (r.correctedAccept || [""])[0], reason: r.reason }
          : { flagged: false };
      }
    } else if (key.type === "doc_flags") {
      for (const inc of key.inconsistencies) {
        s[`sent_${inc.acceptIndices[0]}`] = { flagged: true, reason: inc.reason };
      }
    } else if (key.type === "fact_pick") {
      s["fact_pick"] = String(key.acceptIndex);
    }
  }
  return s;
}

/** Flag literally everything — the spray attack. */
function spraySubmission(keys) {
  const s = {};
  for (const key of keys) {
    if (key.type === "row_check") {
      for (const r of key.rows) s[r.id] = { flagged: true, corrected: "0", reason: "Transposed digits" };
    } else if (key.type === "doc_flags") {
      for (let i = 0; i < 10; i++) s[`sent_${i}`] = { flagged: true, reason: "Date contradicts earlier" };
    }
  }
  return s;
}

const allVariants = Object.values(ALL_VARIANTS).flat();
console.log(`Checking ${allVariants.length} variants × ${SEEDS.length} seeds\n`);

for (const variant of allVariants) {
  const scores = [];
  for (const seed of SEEDS) {
    const { brief, keys } = buildTask(variant, seed, "QuickBooks");

    // 4. Every accept-set has at least one entry.
    for (const key of keys) {
      if (key.type === "email_extract") {
        for (const f of key.fields) {
          if (!f.accept?.length) fail(`${variant}/${seed}: field ${f.id} has no accepted answer`);
          if (f.accept.some((a) => a === "" || a == null)) fail(`${variant}/${seed}: field ${f.id} accepts blank`);
        }
      }
      if (key.type === "queue_sort") {
        for (const it of key.items) {
          if (!it.accept?.length) fail(`${variant}/${seed}: queue ${it.id} has no accepted answer`);
          if (!it.why) fail(`${variant}/${seed}: queue ${it.id} has no explanation for the recruiter`);
        }
      }
      if (key.type === "row_check") {
        if (key.defectCount < 3) fail(`${variant}/${seed}: only ${key.defectCount} defects planted`);
        for (const r of key.rows) {
          if (r.defect && !r.correctedAccept?.length) fail(`${variant}/${seed}: row ${r.id} is a defect with no corrected value`);
        }
      }
      if (key.type === "doc_flags") {
        for (const inc of key.inconsistencies) {
          if (!inc.acceptIndices?.length) fail(`${variant}/${seed}: an inconsistency has no sentence index`);
          if (!inc.why) fail(`${variant}/${seed}: an inconsistency has no explanation`);
        }
      }
    }

    // 1. Perfect scores 100.
    const perfect = scoreTask(variant, seed, perfectSubmission(keys), "QuickBooks");
    if (perfect.pct !== 100) {
      fail(`${variant}/${seed}: a perfect submission scored ${perfect.pct}, not 100`);
      for (const v of perfect.verdicts.filter((v) => !v.correct)) {
        console.log(`      ${v.id}: got ${JSON.stringify(v.got)} expected ${JSON.stringify(v.expected)}`);
      }
    }
    scores.push(perfect.pct);

    // 2. Empty scores 0, and never breaks.
    const empty = scoreTask(variant, seed, {}, "QuickBooks");
    if (!(empty.pct >= 0) || empty.pct > 40) fail(`${variant}/${seed}: empty submission scored ${empty.pct}`);
    if (Number.isNaN(empty.pct)) fail(`${variant}/${seed}: empty submission scored NaN`);

    // 3. Spraying flags must not pay, where there is something to spray.
    const sprayable = keys.some((k) => k.type === "row_check" || k.type === "doc_flags");
    if (sprayable) {
      const spray = scoreTask(variant, seed, spraySubmission(keys), "QuickBooks");
      if (spray.pct > 45) fail(`${variant}/${seed}: flag-everything scored ${spray.pct} — too generous`);
    }

    // 5. The brief must not contain the answer key.
    const briefJson = JSON.stringify(brief);
    for (const key of keys) {
      if (key.type === "email_extract") {
        // The extraction answers ARE in the prose by design — that is the task.
        // What must NOT appear is the marker of which radio option is right.
        const radio = key.fields.find((f) => f.compare === "exact");
        if (radio && briefJson.includes(`"manilaCorrectIndex"`)) {
          fail(`${variant}/${seed}: brief leaks manilaCorrectIndex`);
        }
      }
      if (key.type === "queue_sort") {
        for (const it of key.items) {
          if (briefJson.includes(it.why)) fail(`${variant}/${seed}: brief leaks the rationale for ${it.id}`);
        }
      }
      if (key.type === "row_check") {
        for (const r of key.rows) {
          if (r.defect && briefJson.includes(`"defect":true`)) fail(`${variant}/${seed}: brief leaks defect flags`);
        }
      }
      if (key.type === "doc_flags") {
        for (const inc of key.inconsistencies) {
          if (briefJson.includes(inc.why)) fail(`${variant}/${seed}: brief leaks an inconsistency explanation`);
        }
      }
      if (key.type === "fact_pick") {
        if (briefJson.includes(`"acceptIndex"`)) fail(`${variant}/${seed}: brief leaks the fact_pick answer`);
      }
    }

    // Determinism: same inputs, same brief.
    const again = buildTask(variant, seed, "QuickBooks");
    if (JSON.stringify(again.brief) !== briefJson) fail(`${variant}/${seed}: build is not deterministic`);
  }

  // Different seeds must actually produce different briefs, or the seed buys
  // nothing against a shared answer key.
  const briefs = SEEDS.map((s) => JSON.stringify(buildTask(variant, s, null).brief));
  if (new Set(briefs).size !== SEEDS.length) {
    fail(`${variant}: ${SEEDS.length} seeds produced ${new Set(briefs).size} distinct briefs`);
  }

  const ok = scores.every((s) => s === 100);
  console.log(`  ${ok ? "✓" : "✗"} ${variant.padEnd(22)} perfect=${[...new Set(scores)].join(",")}`);
}

// ── 5b. Every answer must be DERIVABLE from what the candidate can see. ──
//
// This shipped broken: reconcile asked for a corrected rate while its "source"
// quoted no rates at all, so three of the five defect classes were literally
// unanswerable — the candidate could tell a line was wrong and had no way to
// know what it should be. Asking for a value that appears nowhere on the page
// is the English-test defect in a new costume, and a property test is the only
// thing that keeps it from coming back.
console.log("\nAnswerability (every expected value appears in the brief):");
{
  let checked = 0;
  for (const variant of allVariants) {
    for (const seed of SEEDS.slice(0, 3)) {
      const { brief, keys } = buildTask(variant, seed, "QuickBooks");
      const visible = JSON.stringify(brief);
      for (const key of keys) {
        if (key.type !== "row_check") continue;
        for (const r of key.rows) {
          if (!r.defect || !r.correctedAccept) continue;
          checked++;
          // "Derivable" has two shapes, and only one of them is a printed
          // string. A total is COMPUTED from a qty and a rate the candidate can
          // see; a swapped date is RECOVERED from the corrupted one by applying
          // the format rule the source states. Those need no literal. A rate or
          // a reference, on the other hand, exists only if the source names it —
          // no amount of staring at the row recovers a number nobody wrote down.
          // Every defect whose correct value is a fact about the world rather
          // than arithmetic must be named by the source. A swapped date that
          // lands on a REAL date (2026-03-11 -> 2026-11-03) is exactly as
          // unknowable as an unquoted rate, so it belongs on this list too.
          const fromSource = r.reason === "Transposed digits" ||
                             r.reason === "Amount doesn't match source" ||
                             r.reason === "Duplicate reference" ||
                             r.reason === "Date format mismatch";
          if (!fromSource) continue;
          const found = r.correctedAccept.some((a) => {
            if (visible.includes(a)) return true;
            const n = Number(String(a).replace(/[$,]/g, ""));
            return Number.isFinite(n) && visible.includes(n.toFixed(2));
          });
          if (!found) {
            fail(`${variant}/${seed}: row ${r.id} (${r.reason}) expects "${r.correctedAccept[0]}", which the source does not name — the candidate cannot know it`);
          }
        }
      }
    }
  }
  console.log(`  ✓ ${checked} corrected values are all readable off the page`);
}

// ── 5c. Every date we render must be a real date. ──
//
// The day/month swap that plants the date defect produced "2026-24-02" for any
// row whose day exceeded 12. An impossible month is not a transcription error a
// candidate has to catch — it gives the answer away and it reads as our bug,
// not theirs.
console.log("\nDate validity:");
{
  let dates = 0;
  for (const variant of allVariants) {
    for (const seed of SEEDS) {
      const { brief } = buildTask(variant, seed, "QuickBooks");
      const check = (iso, where) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
        if (!m) return;
        dates++;
        const mm = +m[2], dd = +m[3];
        if (mm < 1 || mm > 12 || dd < 1 || dd > 31) {
          fail(`${variant}/${seed}: ${where} renders the impossible date ${iso}`);
        }
      };
      for (const b of brief.blocks) {
        if (b.type !== "row_check") continue;
        for (const r of b.rows) check(r.date, `row ${r.id}`);
        for (const line of b.source) {
          const m = /(\d{4}-\d{2}-\d{2})/.exec(line);
          if (m) check(m[1], "the source");
        }
      }
    }
  }
  console.log(`  ✓ ${dates} rendered dates are all real dates`);
}

// ── 6. A memorised submission must NOT transfer between seeds. ──
//
// This is the property the whole seeding exists for, and it shipped broken
// once: with a fixed defect layout, one memorised submission scored 100% on
// every seed of all three review variants. Rotating the names inside the
// sentences changed nothing, because the answer was never the names.
console.log("\nAnswer-key transfer (a candidate who was handed a friend's answers):");
{
  const TRANSFER_SEEDS = ["XFER00000001", "XFER00000002", "XFER00000003",
    "XFER00000004", "XFER00000005", "XFER00000006"];
  for (const variant of allVariants) {
    // Take the perfect submission for ONE seed and replay it against the others.
    const source = buildTask(variant, TRANSFER_SEEDS[0], "QuickBooks");
    const stolen = perfectSubmission(source.keys);
    const scores = TRANSFER_SEEDS.slice(1).map(
      (s) => scoreTask(variant, s, stolen, "QuickBooks").pct
    );
    const worst = Math.max(...scores);
    // Some transfer is unavoidable and fine — the queue_sort categories are a
    // small space and a guess lands sometimes. What must not happen is a
    // memorised answer scoring like real work.
    const ok = worst < 70;
    if (!ok) fail(`${variant}: a stolen submission still scores ${worst}% on a different seed`);
    console.log(`  ${ok ? "✓" : "✗"} ${variant.padEnd(22)} stolen answers score ${Math.min(...scores)}-${worst}%`);
  }
}

// ── 7. The Manila conversion must match the real IANA timezone database. ──
//
// Checked against Intl rather than against our own arithmetic, so a bug in
// taskSeed cannot validate itself. US DST in 2026 runs 8 March to 1 November;
// Manila is UTC+8 and observes none.
console.log("\nManila conversion vs the IANA database:");
{
  const { seededLiterals } = await import(join(dir, "taskSeed.js"));
  const ZONE_IANA = { Eastern: "America/New_York", Central: "America/Chicago", Pacific: "America/Los_Angeles" };
  const truthManila = (meetingIso, hour24, zoneLabel) => {
    const tz = ZONE_IANA[zoneLabel];
    const [y, m, d] = meetingIso.split("-").map(Number);
    for (let h = 0; h < 48; h++) {
      const inst = new Date(Date.UTC(y, m - 1, d, h));
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric",
        hour12: false, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(inst);
      const get = (t) => Number(parts.find((p) => p.type === t)?.value);
      if (get("year") === y && get("month") === m && get("day") === d && get("hour") === hour24) {
        const mnl = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila",
          weekday: "long", hour: "numeric", hour12: true }).formatToParts(inst);
        const g = (t) => mnl.find((p) => p.type === t)?.value;
        return `${g("hour")}:00 ${mnl.find((p) => p.type === "dayPeriod").value.replace(/ /g, "").toUpperCase()} ${g("weekday")}`;
      }
    }
    return null;
  };
  let checked = 0;
  for (let i = 0; i < 40; i++) {
    const seed = `TZ${String(i).padStart(10, "0")}`;
    for (const v of ["triage_billing", "triage_scheduling", "triage_vendor"]) {
      const L = seededLiterals(v, seed);
      const truth = truthManila(L.meetingIso, L.meetingHour24, L.zoneLabel);
      checked++;
      if (!truth) { fail(`${v}/${seed}: could not resolve a truth time`); continue; }
      if (L.manilaOptions[L.manilaCorrectIndex] !== truth) {
        fail(`${v}/${seed}: correct option is "${L.manilaOptions[L.manilaCorrectIndex]}" but IANA says "${truth}"`);
      }
      // A distractor that is ALSO right makes the item unanswerable.
      if (L.manilaOptions.filter((o, idx) => idx !== L.manilaCorrectIndex && o === truth).length) {
        fail(`${v}/${seed}: a distractor is also the correct answer`);
      }
    }
  }
  console.log(`  ✓ ${checked} generated conversions match the IANA database`);
}

// The DST item is the highest-value item in the design; check it hard.
console.log("\nManila/DST item:");
{
  const { seededLiterals } = await import(join(dir, "taskSeed.js"));
  for (const seed of SEEDS) {
    const L = seededLiterals("triage_billing", seed);
    if (L.manilaOptions.length !== 4) fail(`seed ${seed}: ${L.manilaOptions.length} options, want 4`);
    if (new Set(L.manilaOptions).size !== 4) fail(`seed ${seed}: duplicate options ${JSON.stringify(L.manilaOptions)}`);
    if (L.manilaCorrectIndex < 0 || L.manilaCorrectIndex > 3) fail(`seed ${seed}: correct index ${L.manilaCorrectIndex}`);
  }
  console.log("  ✓ four distinct options and a valid correct index for every seed");
}

rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nAll task-bank assertions passed.");
