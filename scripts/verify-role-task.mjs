/**
 * The acceptance test for the Interview 2 role router.
 *
 * Every value below is a real role_category from the live database on
 * 2026-09-04 (45 distinct values, 256 candidates), plus fixtures for the shapes
 * we know are coming: roles nobody enumerated, roles naming two jobs, and the
 * generic-token traps that make "assistant" undecidable on its own.
 *
 * A mis-route is not a cosmetic bug. It hands somebody a payroll reconciliation
 * when their job is answering client email, and they have a grievance we cannot
 * answer. So this runs in CI, not as a code review.
 *
 *   node scripts/verify-role-task.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── The live cohort: [role_category, candidates, expected key, expected rule] ──
const LIVE = [
  ["Virtual Assistant", 42, "triage", "exact"],
  ["Paralegal", 25, "review", "exact"],
  ["Customer Support Representative", 24, "triage", "exact"],
  ["Administrative Assistant", 21, "triage", "exact"],
  ["Executive Assistant", 16, "triage", "exact"],
  ["Legal Assistant", 15, "review", "exact"],
  ["Data Entry Specialist", 14, "reconcile", "exact"],
  ["Social Media Manager", 10, "triage", "exact"],
  ["Recruitment Coordinator", 8, "triage", "exact"],
  ["Medical Administrative Assistant", 7, "triage", "exact"],
  ["Data Analyst", 5, "reconcile", "exact"],
  ["Graphic Designer", 5, "triage", "exact"],
  ["Appointment Setter", 4, "triage", "exact"],
  ["Legal Secretary", 4, "review", "exact"],
  ["Software Engineer", 4, "triage", "default"],
  ["Web Developer", 4, "triage", "default"],
  ["HR Assistant", 3, "triage", "exact"],
  ["Insurance Verification Specialist", 3, "reconcile", "exact"],
  ["Medical Billing Specialist", 3, "reconcile", "exact"],
  ["Payroll Specialist", 3, "reconcile", "exact"],
  ["Sales Representative", 3, "triage", "exact"],
  ["Account Manager", 2, "triage", "exact"],
  ["Bookkeeper", 2, "reconcile", "exact"],
  ["Cold Caller", 2, "triage", "exact"],
  ["Dental Office Administrator", 2, "triage", "exact"],
  ["Financial Analyst", 2, "reconcile", "exact"],
  ["IT Support", 2, "triage", "default"],
  ["Scheduling Coordinator", 2, "triage", "exact"],
  ["Transcriptionist", 2, "triage", "exact"],
  ["Video Editor", 2, "triage", "exact"],
  ["Accounts Receivable Specialist", 1, "reconcile", "exact"],
  ["AI Engineer", 1, "triage", "default"],
  ["Backend Developer", 1, "triage", "default"],
  ["Content Writer", 1, "triage", "exact"],
  ["Contract Reviewer", 1, "review", "exact"],
  ["CRM Manager", 1, "triage", "exact"],
  ["Email Marketing Specialist", 1, "triage", "exact"],
  ["Geographic Information Systems (GIS) Specialist & Media Buyer", 1, "triage", "conjunction"],
  ["Lead Generation Specialist", 1, "triage", "exact"],
  ["Litigation Support", 1, "review", "exact"],
  ["Office Manager", 1, "triage", "exact"],
  ["Project Manager", 1, "triage", "exact"],
  ["Qualitative Researcher", 1, "triage", "default"],
  ["Real Estate Assistant", 1, "triage", "exact"],
  ["STR Property Manager", 1, "triage", "default"],
];

// ── Shapes we know are coming ──
const FIXTURES = [
  // The generic-token trap: none of these may decide on "assistant" alone.
  ["Marketing Assistant", "triage", null],
  ["Research Assistant", "triage", null],
  ["Personal Assistant", "triage", null],
  // Domain token present and unambiguous — the phrase pass should fire.
  ["Legal Billing Coordinator", null, "ambiguous"], // legal→review, billing→reconcile
  ["Senior Paralegal", "review", "phrase:paralegal"],
  ["Junior Bookkeeper", "reconcile", "phrase:bookkeep"],
  ["Accounts Payable Clerk", "reconcile", "phrase:accounts payable"],
  ["Medical Billing and Coding Specialist", "reconcile", null],
  ["Accounts Payable and Receivable Specialist", "reconcile", null],
  ["Bookkeeping/AP", "reconcile", "phrase:bookkeep"],
  ["Compliance Officer", "review", "phrase:compliance"],
  ["Insurance Claims Processor", "reconcile", null],
  // Longest-first: "medical billing" must beat "billing", both reconcile here,
  // but "medical administrative assistant" must NOT reach a billing phrase.
  ["Medical Administrative Assistant", "triage", "exact"],
  // Two jobs, no domain token either side.
  ["Photographer & Videographer", "triage", "conjunction"],
  ["Copywriter + Designer", "triage", "conjunction"],
  // Degenerate input must never throw.
  ["", "triage", "empty"],
  ["   ", "triage", "empty"],
  ["!!!", "triage", "empty"],
  [null, "triage", "empty"],
  [undefined, "triage", "empty"],
];

// ── Compile roleTask.ts to plain JS so this runs with no build step ──
const dir = mkdtempSync(join(tmpdir(), "roletask-"));
try {
  execFileSync(
    "npx",
    ["tsc", "src/lib/roleTask.ts", "--outDir", dir, "--module", "es2022",
     "--target", "es2022", "--moduleResolution", "bundler"],
    { cwd: process.cwd(), stdio: "pipe" }
  );
} catch (err) {
  console.error("tsc failed:\n" + (err.stdout?.toString() || err.message));
  process.exit(1);
}
const { roleTaskFor } = await import(join(dir, "roleTask.js"));

let failures = 0;
const counts = { triage: 0, reconcile: 0, review: 0 };
const ruleCounts = {};

function check(label, input, wantKey, wantRule, weight) {
  const got = roleTaskFor(input);
  const problems = [];
  if (wantKey && got.key !== wantKey) problems.push(`key ${got.key} != ${wantKey}`);
  if (wantRule && got.rule !== wantRule) problems.push(`rule "${got.rule}" != "${wantRule}"`);
  // An unconfident match must always be the default task, or the disclosure the
  // tips card shows ("we matched you to a general task") would be a lie.
  if (!got.confident && got.key !== "triage") problems.push(`unconfident but key=${got.key}`);
  if (got.rule === "exact" && !got.confident) problems.push("exact but unconfident");
  if (!Array.isArray(got.variantPool) || got.variantPool.length !== 3) {
    problems.push(`variantPool=${JSON.stringify(got.variantPool)}`);
  }
  if (problems.length) {
    failures++;
    console.log(`  ✗ ${label} ${JSON.stringify(input)} — ${problems.join("; ")}`);
  }
  if (weight) {
    counts[got.key] += weight;
    ruleCounts[got.rule] = (ruleCounts[got.rule] || 0) + weight;
  }
  return got;
}

console.log("Live role_category values (2026-09-04):");
for (const [role, n, key, rule] of LIVE) check("live", role, key, rule, n);

console.log("Fixtures:");
for (const [role, key, rule] of FIXTURES) check("fixture", role, key, rule, 0);

// ── Invariants that hold no matter what the table says ──
console.log("Invariants:");

// 1. Determinism: same input, same output, always. The seed and the exposure
//    table both assume this.
for (const [role] of LIVE) {
  const a = JSON.stringify(roleTaskFor(role));
  const b = JSON.stringify(roleTaskFor(role));
  if (a !== b) { failures++; console.log(`  ✗ non-deterministic for ${role}`); }
}

// 2. Case and whitespace cannot change the answer — role_category is free text
//    typed by candidates, and "  paralegal " is the same job as "Paralegal".
for (const [role, , key] of LIVE) {
  if (!role) continue;
  const noisy = roleTaskFor(`  ${role.toUpperCase()}  `);
  if (noisy.key !== key) {
    failures++;
    console.log(`  ✗ case/space changed the answer for ${role}: ${noisy.key} != ${key}`);
  }
}

// 3. Total coverage: every live candidate gets a task. There is no undefined.
const total = LIVE.reduce((s, [, n]) => s + n, 0);
const routed = counts.triage + counts.reconcile + counts.review;
if (routed !== total) {
  failures++;
  console.log(`  ✗ routed ${routed} of ${total} candidates`);
}

console.log(`\nCoverage over ${total} live candidates:`);
for (const k of ["triage", "reconcile", "review"]) {
  console.log(`  ${k.padEnd(10)} ${String(counts[k]).padStart(3)}  (${Math.round((counts[k] / total) * 100)}%)`);
}
console.log("Decided by:");
for (const [rule, n] of Object.entries(ruleCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${rule.padEnd(12)} ${String(n).padStart(3)}`);
}

rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nAll role-router assertions passed.");
