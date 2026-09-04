/**
 * Which performance task does this candidate's role get in Interview 2?
 *
 * Interview 2 already probes the role by voice. What it has never done is watch
 * someone OPERATE A COMPUTER to produce a correct record — read a messy client
 * artifact, get the dates, names, money and references right, decide what to
 * escalate. That is the actual job, and it is the one thing fluent vagueness
 * cannot fake. So the task is deterministic: our code holds the answer key, our
 * code computes the score, and no vendor is in the loop.
 *
 * Three tasks, because VA deliverables reduce to three shapes:
 *   triage    — read a client message, extract the facts, decide what happens next
 *   reconcile — check rows against a source and catch what is wrong
 *   review    — read a document against itself and catch what contradicts
 *
 * Atlas's four categories (engineering / content / sales / design) are not this
 * marketplace. Its live roles are 45 free-text values across 256 candidates, and
 * a quarter of them are in no taxonomy at all — "STR Property Manager",
 * "Qualitative Researcher", "Geographic Information Systems (GIS) Specialist &
 * Media Buyer". A router that cannot answer for a role nobody enumerated is not
 * a router, so the default branch is load-bearing, not a fallback.
 *
 * Atlas gets this wrong in a way worth naming, because it is the bug this file
 * exists to not have: applyRoleTipsForCategory falls back to the engineering
 * card while showIv2ScenarioQuestion's else branch goes straight to the closing.
 * An unmapped role is promised a live coding task and then given no task at all.
 * Here the tips card and the router are THE SAME CALL — Iv2RoleTips renders from
 * exactly the value the serve route acts on, so the promise and the delivery
 * cannot drift.
 */

export type TaskKey = "triage" | "reconcile" | "review";

export interface RoleTaskMatch {
  key: TaskKey;
  /** Which variants this role may be served. Exposure picks from here. */
  variantPool: string[];
  /** How we decided — stored, so a systematic mis-map is one query away. */
  rule: string;
  /** False when we fell through to the default. The candidate is TOLD. */
  confident: boolean;
}

const VARIANT_POOLS: Record<TaskKey, string[]> = {
  triage: ["triage_billing", "triage_scheduling", "triage_vendor"],
  reconcile: ["reconcile_invoice", "reconcile_payroll", "reconcile_claims"],
  review: ["review_intake", "review_casefacts", "review_policy"],
};

/**
 * Exact role → task. Every one of the 46 roles in the platform's roleSkills.ts
 * that is not the default, plus every free-text value observed in the live 256.
 * Explicit beats inferred: when a role is listed here, no phrase rule runs.
 */
const EXACT: Record<string, TaskKey> = {
  // ── review: the work is reading a document against itself ──
  "paralegal": "review",
  "legal assistant": "review",
  "legal secretary": "review",
  "litigation support": "review",
  "contract reviewer": "review",

  // ── reconcile: the work is numbers that have to agree with a source ──
  "bookkeeper": "reconcile",
  "accounts payable specialist": "reconcile",
  "accounts receivable specialist": "reconcile",
  "payroll specialist": "reconcile",
  "tax preparer": "reconcile",
  "financial analyst": "reconcile",
  "data entry specialist": "reconcile",
  "data analyst": "reconcile",
  "medical billing specialist": "reconcile",
  "insurance verification specialist": "reconcile",

  // ── triage: named explicitly where the phrase rules would be ambiguous ──
  // Every role below WOULD reach triage as the default anyway. They are listed
  // so the stored rule reads "exact" rather than "default", which is what makes
  // "how many candidates did we actually guess at?" a query instead of a guess.
  "virtual assistant": "triage",
  "customer support representative": "triage",
  "administrative assistant": "triage",
  "executive assistant": "triage",
  "office manager": "triage",
  "transcriptionist": "triage",
  "medical administrative assistant": "triage",
  "dental office administrator": "triage",
  "scheduling coordinator": "triage",
  "recruitment coordinator": "triage",
  "hr assistant": "triage",
  "real estate assistant": "triage",
  "transaction coordinator": "triage",
  "project manager": "triage",
  "operations assistant": "triage",
  "social media manager": "triage",
  "content writer": "triage",
  "seo specialist": "triage",
  "paid ads specialist": "triage",
  "email marketing specialist": "triage",
  "crm manager": "triage",
  "e-commerce manager": "triage",
  "shopify manager": "triage",
  "amazon store manager": "triage",
  "graphic designer": "triage",
  "video editor": "triage",
  "cold caller": "triage",
  "appointment setter": "triage",
  "sales representative": "triage",
  "sales development representative": "triage",
  "account manager": "triage",
  "lead generation specialist": "triage",
};

/**
 * Phrase → task, for roles nobody enumerated. Longest first, so
 * "medical billing" beats "medical" and "accounts payable" beats "accounts".
 *
 * Every phrase here carries a DOMAIN token. That rule is the load-bearing one:
 * "assistant" alone spans Legal Assistant, Executive Assistant, Administrative
 * Assistant, HR Assistant and Medical Administrative Assistant — five roles
 * across two tasks — so a bare generic token must never decide. Same for
 * specialist, manager, coordinator, representative, associate, officer.
 */
const PHRASES: { phrase: string; key: TaskKey }[] = ([
  // review
  { phrase: "litigation", key: "review" },
  { phrase: "paralegal", key: "review" },
  { phrase: "legal", key: "review" },
  { phrase: "contract review", key: "review" },
  { phrase: "contract analyst", key: "review" },
  { phrase: "deposition", key: "review" },
  { phrase: "discovery", key: "review" },
  { phrase: "compliance", key: "review" },
  { phrase: "document review", key: "review" },
  // reconcile
  { phrase: "bookkeep", key: "reconcile" },
  { phrase: "accounts payable", key: "reconcile" },
  { phrase: "accounts receivable", key: "reconcile" },
  { phrase: "payroll", key: "reconcile" },
  { phrase: "medical billing", key: "reconcile" },
  { phrase: "insurance verification", key: "reconcile" },
  { phrase: "data entry", key: "reconcile" },
  { phrase: "data analyst", key: "reconcile" },
  { phrase: "tax prepar", key: "reconcile" },
  { phrase: "reconcil", key: "reconcile" },
  { phrase: "invoic", key: "reconcile" },
  { phrase: "billing", key: "reconcile" },
  { phrase: "claims", key: "reconcile" },
  { phrase: "accounting", key: "reconcile" },
  { phrase: "auditor", key: "reconcile" },
] as { phrase: string; key: TaskKey }[]).sort((a, b) => b.phrase.length - a.phrase.length);

/**
 * Normalize a free-text role for matching.
 *
 * Parentheticals go because "Sales Development Representative (SDR)" and
 * "Sales Development Representative" are the same job. Punctuation becomes
 * space so "e-commerce" and "e commerce" match, and so a stray comma cannot
 * hide a domain token from the phrase pass.
 */
function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9&+/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Does this role name two jobs? "GIS Specialist & Media Buyer" is one live
 * candidate today and there will be more: a marketplace where people write
 * their own role gets "X & Y" forever.
 *
 * This only ever LABELS a default we were going to take anyway — it never
 * overrides a match. A conjunction is not automatically two jobs: "Accounts
 * Payable and Receivable Specialist" is one, and "Bookkeeping/AP" is one. When
 * both halves point at the same task the phrase pass agrees and we take it;
 * when they disagree the ambiguity rule catches it. So the only thing left for
 * this function to decide is whether an unmatched role went to the default
 * because it names two things or because we simply do not know it — and that
 * distinction is worth storing, because the two need different fixes.
 */
function isConjunction(norm: string): boolean {
  return /(^|\s)(&|\+|and|or)(\s|$)/.test(norm) || norm.includes("/");
}

const DEFAULT_KEY: TaskKey = "triage";

/**
 * The router. Pure — no I/O, no DB, no vendor — so the verify script can run it
 * over every live role value and assert the whole mapping in milliseconds.
 *
 * Read the role from ai_interviews.role_category (the snapshot written when the
 * interview opened), NEVER from candidates.role_category: migration 00120 grants
 * authenticated UPDATE on that column, so a candidate could otherwise change
 * their role between the tips card and the serve and pick their own exam.
 */
export function roleTaskFor(roleCategory: string | null | undefined): RoleTaskMatch {
  const fallback = (rule: string): RoleTaskMatch => ({
    key: DEFAULT_KEY,
    variantPool: VARIANT_POOLS[DEFAULT_KEY],
    rule,
    confident: false,
  });

  if (!roleCategory || !roleCategory.trim()) return fallback("empty");

  const norm = normalize(roleCategory);
  if (!norm) return fallback("empty");

  const exact = EXACT[norm];
  if (exact) {
    return { key: exact, variantPool: VARIANT_POOLS[exact], rule: "exact", confident: true };
  }

  // Collect every phrase that matches, then require them to agree.
  const hits = PHRASES.filter((p) => norm.includes(p.phrase));
  if (hits.length === 0) return fallback(isConjunction(norm) ? "conjunction" : "default");

  const keys = new Set(hits.map((h) => h.key));
  if (keys.size > 1) {
    // Two different tasks both have a claim. Guessing here is how somebody ends
    // up doing a payroll reconciliation because their title said "legal billing
    // coordinator". Fall through, flagged.
    return fallback("ambiguous");
  }

  const key = hits[0].key;
  return {
    key,
    variantPool: VARIANT_POOLS[key],
    rule: `phrase:${hits[0].phrase}`,
    confident: true,
  };
}

/** Human-facing task names. Used by the tips card and the recruiter view. */
export const TASK_LABELS: Record<TaskKey, string> = {
  triage: "Client request handling",
  reconcile: "Records accuracy check",
  review: "Document review",
};
