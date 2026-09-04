/**
 * The nine Interview 2 task variants, as data.
 *
 * Each builder takes the seeded literals and returns two things: the BRIEF (what
 * the candidate sees, which never contains an answer) and the KEY (what the
 * checker scores against, which never leaves the server). The split is the point
 * — `serve` sends the brief and nothing else, so there is no answer key in the
 * page, in the network tab, or in a submit response.
 *
 * Structure is hand-authored so a person can audit every item. If an item turns
 * out to have two defensible answers, the fix is to widen its accept-set here,
 * in one place, and every past submission can be re-scored from its stored seed.
 */
import type { TaskKey } from "@/lib/roleTask";
import { rngFor, seededLiterals, shuffled, type SeededLiterals } from "@/lib/taskSeed";

// ── Brief shapes (client-visible) ────────────────────────────────────────

export interface BriefField {
  id: string;
  label: string;
  hint?: string;
  kind: "text" | "radio";
  options?: string[];
}

export interface BriefQueueItem {
  id: string;
  text: string;
}

export interface BriefRow {
  id: string;
  ref: string;
  date: string;
  description: string;
  qty: string;
  rate: string;
  lineTotal: string;
}

export type BriefBlock =
  | { type: "email_extract"; heading: string; prose: string[]; fields: BriefField[] }
  | { type: "queue_sort"; heading: string; instruction: string; actions: string[]; items: BriefQueueItem[] }
  | { type: "row_check"; heading: string; instruction: string; source: string[]; rows: BriefRow[]; reasons: string[] }
  | { type: "doc_flags"; heading: string; instruction: string; sentences: string[]; reasons: string[] }
  | { type: "fact_pick"; heading: string; message: string; question: string; options: string[] };

export interface TaskBrief {
  key: TaskKey;
  variant: string;
  title: string;
  intro: string;
  softSeconds: number;
  blocks: BriefBlock[];
}

// ── Key shapes (server-only) ─────────────────────────────────────────────

export interface FieldKey {
  id: string;
  /** Accepted answers. For radio, the index as a string. */
  accept: string[];
  /** How the checker normalizes before comparing. */
  compare: "name" | "date" | "amount" | "ref" | "exact";
  points: number;
}

export interface QueueKey {
  id: string;
  /** One OR two categories, where two are genuinely defensible. */
  accept: string[];
  points: number;
  why: string;
}

export interface RowKey {
  id: string;
  defect: boolean;
  /** Only set when defect. */
  correctedAccept?: string[];
  reason?: string;
  why: string;
}

export interface DocKey {
  /** A contradiction spans two sentences; either is defensible. */
  acceptIndices: number[];
  reason: string;
  why: string;
}

export type TaskAnswerKey =
  | { type: "email_extract"; fields: FieldKey[] }
  | { type: "queue_sort"; items: QueueKey[] }
  | { type: "row_check"; rows: RowKey[]; defectCount: number }
  | { type: "doc_flags"; inconsistencies: DocKey[]; penaltyPerFalsePositive: number }
  | { type: "fact_pick"; acceptIndex: number; points: number; why: string };

export interface BuiltTask {
  brief: TaskBrief;
  keys: TaskAnswerKey[];
}

// ── Shared vocabulary ────────────────────────────────────────────────────

const QUEUE_ACTIONS = ["Do now", "Schedule for later", "Ask the client", "No action needed"];
const ROW_REASONS = [
  "Transposed digits",
  "Duplicate reference",
  "Total ≠ qty × rate",
  "Date format mismatch",
  "Amount doesn't match source",
];
/** The defect classes a reconcile variant can plant. Same strings as
 *  ROW_REASONS, so the candidate's dropdown and the key share one vocabulary. */
type DefectClass =
  | "Transposed digits"
  | "Duplicate reference"
  | "Total ≠ qty × rate"
  | "Date format mismatch"
  | "Amount doesn't match source";

const DOC_REASONS = [
  "Name doesn't match earlier",
  "Date contradicts earlier",
  "Amount doesn't add up",
  "Status contradicts earlier",
  "Missing required detail",
];

/**
 * The transcript-seeded queue item. At serve time we look for exact matches
 * against a fixed lexicon in what the candidate has already said in THIS
 * interview — no regex cleverness, no model call, because the default task
 * cannot be allowed to depend on the vendor that is out of credit today.
 *
 * It raises the cost of an outside oracle (which does not have the
 * conversation) without gating anything: a candidate who retypes one sentence
 * defeats it in fifteen seconds. It is worth it because it is nearly free.
 */
export const TOOL_LEXICON = [
  "Slack", "HubSpot", "QuickBooks", "Zendesk", "Clio", "Asana", "Calendly",
  "Trello", "Notion", "Monday.com", "Salesforce", "Zoho", "Xero", "FreshBooks",
  "Gusto", "Shopify", "Mailchimp", "Klaviyo", "Airtable", "Basecamp",
  "Google Calendar", "Outlook", "Zoom", "Microsoft Teams", "Dropbox",
  "DocuSign", "Canva", "Figma", "Jira", "Intercom", "Freshdesk", "Podio",
  "Bill.com", "Expensify", "Wave", "Sage", "NetSuite", "Buildium", "AppFolio",
];

export function findSeededTool(transcript: { role: string; text: string }[]): string | null {
  const said = transcript
    .filter((e) => e.role === "candidate")
    .map((e) => e.text)
    .join(" ");
  // Longest first so "Google Calendar" beats "Calendar" and "Bill.com" is not
  // shadowed. Word-boundary matched so "Wave" does not fire inside "waveform".
  for (const tool of [...TOOL_LEXICON].sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9])${tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`, "i");
    if (pattern.test(said)) return tool;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// TRIAGE — the default. 69% of the live cohort.
// ═══════════════════════════════════════════════════════════════════════

/**
 * The queue-item pool.
 *
 * Six are drawn per interview, by seed. They were fixed per variant at first,
 * and the transfer test caught it: a memorised set of six answers scored 54% on
 * every seed, because the items never moved. Judgement items are the easiest
 * thing in the whole task to write down and pass on — four options, six rows —
 * so the pool has to be wide enough that a shared list is mostly wrong.
 *
 * Each item's accept-set holds one OR two categories. Two are listed wherever
 * both are genuinely defensible, because a judgement item with one grudging
 * right answer is how the English test ended up with 17 disputed questions.
 */
interface QueueSpec { id: string; text: (L: SeededLiterals) => string; accept: string[]; why: string }

const QUEUE_POOL: QueueSpec[] = [
  { id: "qp_bank", text: (L) => `A vendor emails asking you to update their bank details for future payments. It is a reply inside a real thread with ${L.company}.`,
    accept: ["Ask the client"], why: "Bank-detail changes by email are the commonest invoice fraud there is. Verify out of band — and the client decides, not you." },
  { id: "qp_resend", text: () => `A teammate asks for the Q2 expense spreadsheet you already sent her last week.`,
    accept: ["Do now", "No action needed"], why: "Re-sending takes a minute; pointing at the earlier email is also fine. Either is defensible." },
  { id: "qp_delegate", text: (L) => `${L.contactName} forwards a customer complaint and asks you to "handle it however you think best."`,
    accept: ["Do now", "Schedule for later"], why: "The client explicitly delegated it. Handling it is the job; scheduling it is fine if something else is more urgent." },
  { id: "qp_domain", text: (L) => `An automated reminder says the ${L.company} domain renews in 45 days.`,
    accept: ["Schedule for later", "No action needed"], why: "45 days is not urgent. Diarising it or leaving it to the automated reminder are both reasonable." },
  { id: "qp_overbill", text: () => `A supplier's invoice arrives $40 higher than the quote, with no explanation.`,
    accept: ["Ask the client"], why: "A price difference nobody explained is the client's money. Query it — but do not decide to pay or refuse on their behalf." },
  { id: "qp_double", text: () => `Two meetings on the client's calendar overlap on Thursday. One is with a customer, one is internal.`,
    accept: ["Do now"], why: "A double-booking gets worse every hour it sits. The customer meeting holds; move the internal one." },
  { id: "qp_recruiter", text: (L) => `A recruiter emails asking whether ${L.contactName} is "open to opportunities."`,
    accept: ["No action needed", "Ask the client"], why: "Not yours to answer. Ignoring it or forwarding it are both fine; replying on their behalf is not." },
  { id: "qp_flight", text: () => `The client's flight confirmation arrives. The return leg lands two hours after a meeting you booked for them.`,
    accept: ["Do now"], why: "A meeting they physically cannot attend is a live problem, and it is yours to fix — you booked it." },
  { id: "qp_shift", text: () => `A colleague asks you to move a recurring 1:1 by fifteen minutes, permanently.`,
    accept: ["Do now", "Schedule for later"], why: "A fifteen-minute shift to a recurring internal slot is routine housekeeping." },
  { id: "qp_unknown", text: () => `A calendar invite arrives from an address you do not recognise, for "contract review", with no agenda.`,
    accept: ["Ask the client"], why: "An unknown sender asking for time about a contract is either phishing or something the client knows about. Check before accepting or deleting." },
  { id: "qp_w9", text: () => `A new vendor sends a W-9 and asks to be set up for payment this week.`,
    accept: ["Do now", "Schedule for later"], why: "Onboarding paperwork is the job. Doing it now or slotting it into the week are both fine." },
  { id: "qp_prices", text: () => `An existing supplier emails their updated price list, effective next quarter.`,
    accept: ["Schedule for later", "No action needed"], why: "Effective next quarter is not urgent. File it or diarise it." },
  { id: "qp_courier", text: (L) => `${L.contactName} asks you to "pick whichever courier is cheapest" for a recurring shipment.`,
    accept: ["Do now"], why: "The client gave you the decision rule — cheapest. Applying a rule you were handed is not escalating." },
  { id: "qp_password", text: () => `A vendor portal emails that your password expires in 10 days.`,
    accept: ["Do now", "Schedule for later"], why: "Housekeeping with a deadline. Either is defensible; ignoring it is not." },
  { id: "qp_renew", text: (L) => `A supplier asks you to confirm, in writing, that ${L.company} will renew for another year.`,
    accept: ["Ask the client"], why: "Committing the company to a year of spend is not a virtual assistant's signature to give." },
  { id: "qp_refund", text: () => `A customer asks for a refund that is $30 outside the published policy.`,
    accept: ["Ask the client"], why: "Going outside the client's own policy is the client's decision, not a favour you can grant." },
  { id: "qp_typo", text: (L) => `You notice a typo in ${L.company}'s published booking page.`,
    accept: ["Do now", "Schedule for later"], why: "Small, reversible, obviously an improvement. Fixing it is what you are there for." },
  { id: "qp_review", text: () => `A one-star public review appears, naming a staff member.`,
    accept: ["Ask the client"], why: "A public reply about a named employee is reputational and personnel-sensitive. Flag it up; do not answer it yourself." },
  { id: "qp_dupe_invoice", text: () => `The same invoice arrives twice, a week apart, with the same number.`,
    accept: ["Do now", "Ask the client"], why: "Catching a duplicate before it is paid is the job; confirming with the client before voiding it is equally sound." },
  { id: "qp_ooo", text: (L) => `${L.otherName} is out and his auto-reply points everything at you, including things you have no access to.`,
    accept: ["Ask the client"], why: "You cannot do what you cannot access. Say so early rather than sitting on a queue you cannot clear." },
];

/** Six items, drawn by seed, plus the transcript-seeded one. */
function drawQueue(
  variant: string,
  seed: string,
  L: SeededLiterals,
  tool: string | null
): { items: BriefQueueItem[]; keys: QueueKey[] } {
  const rnd = rngFor(variant, seed + ":queue");
  const picked = shuffled(rnd, QUEUE_POOL).slice(0, 5);
  const seeded = seededQueueItem(tool);
  const combined = shuffled(rnd, [
    ...picked.map((q) => ({
      item: { id: q.id, text: q.text(L) },
      key: { id: q.id, accept: q.accept, points: 1, why: q.why },
    })),
    { item: seeded.item, key: seeded.key },
  ]);
  return { items: combined.map((c) => c.item), keys: combined.map((c) => c.key) };
}

function triageFields(L: SeededLiterals): { fields: BriefField[]; key: FieldKey[] } {
  return {
    fields: [
      { id: "contact_name", label: "Who should the reply go to?", kind: "text" },
      { id: "due_date", label: "What date do they need it by?", hint: "YYYY-MM-DD", kind: "text" },
      { id: "amount", label: "What amount is in dispute?", hint: "e.g. 1234.00", kind: "text" },
      { id: "reference", label: "What is the reference number?", kind: "text" },
      {
        id: "meeting_time_manila",
        label: `They proposed ${L.meetingPretty} ${L.zoneAbbrev}. What time is that for you in Manila?`,
        kind: "radio",
        options: L.manilaOptions,
      },
    ],
    key: [
      { id: "contact_name", accept: [L.contactName, L.contactFirst + " " + L.contactLast], compare: "name", points: 1 },
      { id: "due_date", accept: [L.dueIso], compare: "date", points: 1 },
      { id: "amount", accept: [String(L.amount)], compare: "amount", points: 1 },
      { id: "reference", accept: [L.reference], compare: "ref", points: 1 },
      { id: "meeting_time_manila", accept: [String(L.manilaCorrectIndex)], compare: "exact", points: 1 },
    ],
  };
}

/** The one item that references something the candidate said out loud. */
function seededQueueItem(tool: string | null): { item: BriefQueueItem; key: QueueKey } {
  if (tool) {
    return {
      item: {
        id: "q_seeded",
        text: `Earlier you mentioned working in ${tool}. The client asks you to give their new bookkeeper your ${tool} login so she can "check something quickly."`,
      },
      key: {
        id: "q_seeded",
        accept: ["Ask the client"],
        points: 1,
        why: "Never share your own credentials. The client can issue the bookkeeper her own access — but that is the client's call to make, so you ask rather than refuse or comply.",
      },
    };
  }
  return {
    item: {
      id: "q_seeded",
      text: `The client asks you to give their new bookkeeper your login to the accounting system so she can "check something quickly."`,
    },
    key: {
      id: "q_seeded",
      accept: ["Ask the client"],
      points: 1,
      why: "Never share your own credentials. The client can issue the bookkeeper her own access — but that is the client's call, so you ask rather than refuse or comply.",
    },
  };
}

/** The three triage variants differ only in the forwarded email. The queue is
 *  drawn from the shared pool by seed, so no variant carries a fixed answer. */
function buildTriage(
  variant: string,
  L: SeededLiterals,
  seed: string,
  tool: string | null,
  email: { subject: string; body: string[] }
): BuiltTask {
  const f = triageFields(L);
  const q = drawQueue(variant, seed, L, tool);

  return {
    brief: {
      key: "triage",
      variant,
      title: "A client request, start to finish",
      intro: `${L.contactName} at ${L.company} has forwarded you a message. Read it, pull out what you need, then work through what came in behind it.`,
      softSeconds: 7 * 60,
      blocks: [
        {
          type: "email_extract",
          heading: "The forwarded message",
          prose: [
            `From: ${L.contactFirst.toLowerCase()}.${L.contactLast.toLowerCase()}@${L.company.toLowerCase().replace(/[^a-z]/g, "")}.com`,
            `Subject: ${email.subject}`,
            ``,
            ...email.body,
            ``,
            `Thanks,`,
            `${L.contactName}`,
          ],
          fields: f.fields,
        },
        {
          type: "queue_sort",
          heading: "What came in behind it",
          instruction:
            "Six things landed while you were reading. Pick one action for each. Several have more than one defensible answer — but deciding something the client should decide, and escalating something you could just do, are both counted.",
          actions: QUEUE_ACTIONS,
          items: q.items,
        },
      ],
    },
    keys: [
      { type: "email_extract", fields: f.key },
      { type: "queue_sort", items: q.keys },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// RECONCILE — 13% of the cohort. Rows against a source.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Twelve rows, four planted defects, and one legitimate row that LOOKS wrong.
 * Scoring is F1 over the flag decision, so flagging everything scores about
 * 30% and flagging nothing scores 0. The false-positive trap is the whole
 * discriminator: in bookkeeping, querying a correct invoice costs a client
 * relationship, and that is the expensive mistake nobody tests for.
 */
function money(n: number): string {
  return n.toFixed(2);
}

function buildReconcile(
  variant: string,
  L: SeededLiterals,
  seed: string,
  cfg: {
    title: string;
    sourceHeading: string;
    rules: string[];
    unitWord: string;
    descriptions: string[];
    defectPool: DefectClass[];
    decoyNote: string;
  }
): BuiltTask {
  const rnd = rngFor(variant, seed);
  const base = L.amount;
  // Non-sequential on purpose. An arithmetic run (4200, 4207, 4214, …) means a
  // candidate never has to read a reference — the duplicate announces itself as
  // the one that breaks the run, and the extraction is arithmetic rather than
  // attention. These are drawn from the seed and sorted only by their own
  // digits, so nothing about position predicts them.
  const refNums = shuffled(rnd, Array.from({ length: 40 }, (_, k) => 41000 + k * 137)).slice(0, 12);
  const refFor = (i: number) => `${L.reference.slice(0, 3)}-${String(refNums[i]).padStart(5, "0")}`;

  // WHICH rows are wrong, WHICH defects they carry, and WHERE the decoy sits
  // are all drawn from the seed. With a fixed layout a single memorised
  // submission scored the same on every seed, which is the shared-answer-key
  // failure the seeding exists to prevent.
  const positions = shuffled(rnd, Array.from({ length: 12 }, (_, i) => i));
  const defects = shuffled(rnd, cfg.defectPool).slice(0, 4);
  const defectRows = positions.slice(0, 4);
  const decoyRow = positions[4];
  const assigned = new Map<number, DefectClass>();
  defectRows.forEach((row, i) => assigned.set(row, defects[i]));

  const donorRow = positions.slice(5).find((i) => !assigned.has(i) && i !== decoyRow) ?? positions[11];

  // The TRUTH, row by row. This is the whole point of the block and the first
  // version did not have it: the source said "all rates are as quoted" and then
  // quoted nothing, so a transposed rate, an amount that disagreed with the
  // source, and a duplicated reference were all literally unanswerable — the
  // candidate could see something was wrong and had no way to know what it
  // should be. Asking for a corrected value that appears nowhere on the page is
  // the English-test defect in a new costume.
  //
  // Listing the truth does not give the task away. Reconciliation IS comparing
  // two lists; the skill is doing it carefully across twelve rows, under a
  // clock, without flagging the one that only looks wrong.
  const truth: { ref: string; date: string; qty: number; rate: number }[] = [];
  const rows: BriefRow[] = [];
  const keys: RowKey[] = [];

  for (let i = 0; i < 12; i++) {
    const qty = 1 + ((i * 3 + Math.floor(rnd() * 3)) % 6);
    const rate = i === decoyRow ? 5000 : 40 + ((base + i * 37) % 900);
    const trueQty = i === decoyRow ? 1 : qty;
    // The day stays inside 1..12 on the row that will carry the date defect,
    // so swapping it produces a REAL date rather than "2026-24-02". An
    // impossible month is not a transcription error a candidate has to catch —
    // it is obviously our bug, it gives the answer away for free, and it makes
    // the product look like it cannot format a date. A valid-but-swapped date
    // is the actual ambiguity this item is testing, and the source resolves it.
    const dateDefect = assigned.get(i) === "Date format mismatch";
    const dayRaw = ((i * 5) % 27) + 1;
    const day = dateDefect ? ((dayRaw - 1) % 12) + 1 : dayRaw;
    const month = ((L.dueIso.charCodeAt(6) + i) % 9) + 1;
    const date = `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    truth.push({ ref: refFor(i), date, qty: trueQty, rate });

    const row: BriefRow = {
      id: `r${i + 1}`,
      ref: refFor(i),
      date,
      description: cfg.descriptions[i % cfg.descriptions.length],
      qty: String(trueQty),
      rate: money(rate),
      lineTotal: money(trueQty * rate),
    };

    const defect = assigned.get(i);
    let corrected: string[] | undefined;
    let why = "Clean — it matches the source.";

    if (defect) {
      switch (defect) {
        case "Transposed digits": {
          const digits = String(Math.round(rate));
          const swapped =
            digits.length >= 2
              ? Number(digits.slice(0, -2) + digits.slice(-1) + digits.slice(-2, -1))
              : rate + 9;
          row.rate = money(swapped);
          row.lineTotal = money(trueQty * swapped);
          corrected = [money(rate), String(rate)];
          why = `Billed at ${money(swapped)}; the source says ${money(rate)} — the last two digits are swapped.`;
          break;
        }
        case "Total ≠ qty × rate": {
          row.lineTotal = money(trueQty * rate + 90);
          corrected = [money(trueQty * rate), String(trueQty * rate)];
          why = `${trueQty} × ${money(rate)} is ${money(trueQty * rate)}, not the total billed.`;
          break;
        }
        case "Duplicate reference": {
          row.ref = refFor(donorRow);
          corrected = [refFor(i)];
          why = `This line carries ${refFor(donorRow)}, which is already on row ${donorRow + 1}. The source shows ${refFor(i)} is the reference nothing else claims.`;
          break;
        }
        case "Date format mismatch": {
          const [, m, d] = date.split("-");
          row.date = `2026-${d.padStart(2, "0")}-${m.padStart(2, "0")}`;
          corrected = [`2026-${m}-${d}`, `${m}/${d}/2026`];
          why = "The day and month are swapped relative to every other row and to the stated format.";
          break;
        }
        case "Amount doesn't match source": {
          row.rate = money(rate + 100);
          row.lineTotal = money(trueQty * (rate + 100));
          corrected = [money(rate), String(rate)];
          why = `Billed at ${money(rate + 100)}; the source allows ${money(rate)}.`;
          break;
        }
      }
    }

    if (i === decoyRow) why = cfg.decoyNote;

    rows.push(row);
    keys.push({ id: row.id, defect: !!defect, correctedAccept: corrected, reason: defect, why });
  }

  // The source, rendered as the document it is meant to be.
  // The source lists DATES as well as rates. Without them, a day/month swap
  // that lands on a real date — 2026-03-11 becoming 2026-11-03 — is invisible:
  // the row is internally plausible and nothing on the page disagrees with it.
  // That is the same unanswerable-item defect as a rate with no quoted rate.
  //
  // The source is also SHUFFLED relative to the invoice, because a real
  // purchase order and a real invoice never arrive in the same order, and a
  // line-by-line scan down two parallel columns is not reconciliation.
  const sourceOrder = shuffled(rngFor(variant, seed + ":source"), truth);
  const sourceLines = [
    ...cfg.rules,
    "",
    `REF            DATE         ${cfg.unitWord.toUpperCase().padEnd(6)} RATE`,
    ...sourceOrder.map(
      (t) => `${t.ref}   ${t.date}   ${String(t.qty).padEnd(6)} ${money(t.rate)}`
    ),
  ];

  return {
    brief: {
      key: "reconcile",
      variant,
      title: cfg.title,
      intro: `Twelve lines came through. The source they should match is above them. Some lines are wrong — flag those, say why, and type what the value should be. Everything you need to check them is on this page. Not every line that looks odd is an error, and flagging a correct one costs you.`,
      softSeconds: 6 * 60,
      blocks: [
        {
          type: "row_check",
          heading: cfg.sourceHeading,
          instruction: "Tick a row only if it disagrees with the source or does not add up. When you tick it, say why and give the corrected value.",
          source: sourceLines,
          rows,
          reasons: ROW_REASONS,
        },
      ],
    },
    keys: [{ type: "row_check", rows: keys, defectCount: 4 }],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// REVIEW — 18% of the cohort. A document against itself.
// ═══════════════════════════════════════════════════════════════════════

/**
 * A review document, assembled from parts so the SEED decides where the
 * contradictions sit.
 *
 * The first version hard-coded the sentence order, and a single memorised
 * submission — "flag sentences 5 and 7, pick these reasons" — scored 100% on
 * every seed of all three variants. Rotating the names inside the sentences
 * changed nothing, because the answer was never the names. Here the neutral
 * filler and the contradiction pairs are shuffled together, so the indices a
 * candidate would have to memorise are different every time.
 */
interface ReviewPart {
  /** The two sentences that contradict each other. Either may be flagged. */
  pair: [string, string];
  reason: string;
  why: string;
}

function buildReviewDoc(
  variant: string,
  seed: string,
  filler: string[],
  parts: ReviewPart[]
): { sentences: string[]; inconsistencies: DocKey[] } {
  const rnd = rngFor(variant, seed);

  // Each contradiction is a pair that must stay in order — the second sentence
  // only reads as wrong once the first has been read — but WHERE each pair
  // starts, and which filler separates them, is drawn from the seed.
  const slots: { text: string; part: number | null; half: 0 | 1 }[] = [];
  parts.forEach((p, i) => {
    slots.push({ text: p.pair[0], part: i, half: 0 });
    slots.push({ text: p.pair[1], part: i, half: 1 });
  });
  const fill = shuffled(rnd, filler).map((t) => ({ text: t, part: null, half: 0 as const }));

  // Interleave: walk the filler and drop the pair halves in at seeded points,
  // keeping each pair's own order intact.
  const pending = slots.filter((s) => s.half === 0);
  const seconds = new Map(parts.map((_, i) => [i, slots.find((s) => s.part === i && s.half === 1)!]));
  const out: typeof slots = [];
  const firstOrder = shuffled(rnd, pending);
  let fi = 0;
  const openPairs: number[] = [];

  while (firstOrder.length || openPairs.length || fi < fill.length) {
    const roll = rnd();
    if (firstOrder.length && (roll < 0.34 || (fi >= fill.length && !openPairs.length))) {
      const s = firstOrder.shift()!;
      out.push(s);
      openPairs.push(s.part as number);
    } else if (openPairs.length && (roll < 0.62 || (fi >= fill.length && !firstOrder.length))) {
      // Close the oldest open pair, so a contradiction never sits adjacent to
      // its own first half — that would make it findable without reading.
      const idx = openPairs.shift()!;
      out.push(seconds.get(idx)!);
    } else if (fi < fill.length) {
      out.push(fill[fi++]);
    } else if (firstOrder.length) {
      const s = firstOrder.shift()!;
      out.push(s);
      openPairs.push(s.part as number);
    } else if (openPairs.length) {
      out.push(seconds.get(openPairs.shift()!)!);
    }
  }

  const sentences = out.map((s) => s.text);
  const inconsistencies: DocKey[] = parts.map((p, i) => ({
    acceptIndices: out
      .map((s, idx) => (s.part === i ? idx : -1))
      .filter((idx) => idx >= 0),
    reason: p.reason,
    why: p.why,
  }));
  return { sentences, inconsistencies };
}

function buildReview(
  variant: string,
  seed: string,
  cfg: {
    title: string;
    docHeading: string;
    filler: string[];
    parts: ReviewPart[];
    trapMessage: string;
    trapQuestion: string;
    trapOptions: string[];
    trapAcceptIndex: number;
    trapWhy: string;
  }
): BuiltTask {
  const { sentences, inconsistencies } = buildReviewDoc(variant, seed, cfg.filler, cfg.parts);

  // The trap's options are shuffled too, so "the answer is option 3" is not
  // shareable either.
  const rnd = rngFor(variant, seed + ":trap");
  const correct = cfg.trapOptions[cfg.trapAcceptIndex];
  const options = shuffled(rnd, cfg.trapOptions);

  return {
    brief: {
      key: "review",
      variant,
      title: cfg.title,
      intro: `Read the document below. Somewhere in it, the document contradicts itself — a name that changes, a date that cannot be right, a figure that does not add up. Click the sentence where you notice each problem and say what kind it is. Everything you need is on the page; you are not being asked to know the law.`,
      softSeconds: 7 * 60,
      blocks: [
        {
          type: "doc_flags",
          heading: cfg.docHeading,
          instruction: "Click a sentence to flag it, then pick what is wrong. Flagging a sentence that is fine costs you half a point.",
          sentences,
          reasons: DOC_REASONS,
        },
        {
          type: "fact_pick",
          heading: "Then: the client asks you a question",
          message: cfg.trapMessage,
          question: cfg.trapQuestion,
          options,
        },
      ],
    },
    keys: [
      { type: "doc_flags", inconsistencies, penaltyPerFalsePositive: 0.5 },
      { type: "fact_pick", acceptIndex: options.indexOf(correct), points: 2, why: cfg.trapWhy },
    ],
  };
}

// ── The registry ─────────────────────────────────────────────────────────

export const ALL_VARIANTS: Record<TaskKey, string[]> = {
  triage: ["triage_billing", "triage_scheduling", "triage_vendor"],
  reconcile: ["reconcile_invoice", "reconcile_payroll", "reconcile_claims"],
  review: ["review_intake", "review_casefacts", "review_policy"],
};

/**
 * Build a task from (variant, seed). Pure and deterministic: the same pair
 * always produces the same brief and the same key, which is what makes an
 * appeal re-runnable months later from two stored strings.
 */
export function buildTask(
  variant: string,
  seed: string,
  seededTool: string | null = null
): BuiltTask {
  const L = seededLiterals(variant, seed);

  switch (variant) {
    case "triage_billing":
      return buildTriage("triage_billing", L, seed, seededTool, {
        subject: "FW: invoice query — please handle",
        body: [
          `Hi — passing this straight to you.`,
          ``,
          `Our accounts team is disputing invoice ${L.reference}. They say the total should be ${L.amountPretty}, not what was billed, and they want it resolved before ${L.duePretty} because that's when their quarter closes.`,
          ``,
          `I've cc'd ${L.otherName} but honestly he's out most of this week, so please just deal with it directly with their side.`,
          ``,
          `Can we talk it through? I'm free ${L.meetingPretty} ${L.zoneAbbrev} — does that work your end?`,
        ],
      });
    case "triage_scheduling":
      return buildTriage("triage_scheduling", L, seed, seededTool, {
        subject: "FW: site visit + the outstanding balance",
        body: [
          `Morning — two things, sorry to lump them together.`,
          ``,
          `First, their office manager wants the site visit confirmed and everything signed off by ${L.duePretty}. Second, there's still ${L.amountPretty} outstanding on ref ${L.reference} and they will not schedule until that's cleared.`,
          ``,
          `${L.otherName} was handling this before but he's moved teams, so it's with you now.`,
          ``,
          `I can jump on a call ${L.meetingPretty} ${L.zoneAbbrev} if that's a reasonable hour for you.`,
        ],
      });
    case "triage_vendor":
      return buildTriage("triage_vendor", L, seed, seededTool, {
        subject: "FW: onboarding the new supplier",
        body: [
          `Hi — can you take this one over?`,
          ``,
          `They need to be fully set up in our system by ${L.duePretty}. Their first invoice is already in for ${L.amountPretty} against PO ${L.reference}, and procurement won't release it until the vendor record exists.`,
          ``,
          `${L.otherName} started the paperwork but didn't finish it before he went on leave.`,
          ``,
          `Shall we sync? I have a window ${L.meetingPretty} ${L.zoneAbbrev}.`,
        ],
      });

    case "reconcile_invoice":
      return buildReconcile("reconcile_invoice", L, seed, {
        title: "Invoice lines against the purchase order",
        sourceHeading: `Purchase order ${L.reference} — ${L.company}`,
        rules: [
          `Purchase order ${L.reference}, raised ${L.duePretty}.`,
          `Line totals are quantity × rate. Every reference below is unique to one line.`,
          `All dates are written year-month-day.`,
        ],
        unitWord: "qty",
        descriptions: ["Consumables", "Service call-out", "Replacement part",
          "Delivery", "Labour", "Materials"],
        defectPool: ["Transposed digits", "Total ≠ qty × rate", "Duplicate reference",
          "Date format mismatch", "Amount doesn't match source"],
        decoyNote: "Correct. A round $5,000.00 looks like an unreplaced placeholder, but it matches the order — flagging it costs precision.",
      });
    case "reconcile_payroll":
      return buildReconcile("reconcile_payroll", L, seed, {
        title: "Payroll register against the timesheet",
        sourceHeading: `Timesheet summary — period ending ${L.duePretty}`,
        rules: [
          `Hours as submitted and approved by the supervisor.`,
          `Pay is hours × rate. No overtime multiplier applies this period.`,
          `Each reference below belongs to one line. All dates are year-month-day.`,
        ],
        unitWord: "hours",
        descriptions: ["Regular hours", "Holiday cover", "Weekend shift",
          "On-call", "Training", "Standby"],
        defectPool: ["Amount doesn't match source", "Total ≠ qty × rate", "Transposed digits",
          "Duplicate reference", "Date format mismatch"],
        decoyNote: "Correct. A flat $5,000.00 for a single unit reads like a placeholder, but the timesheet supports it.",
      });
    case "reconcile_claims":
      return buildReconcile("reconcile_claims", L, seed, {
        title: "Claim lines against the explanation of benefits",
        sourceHeading: `Explanation of benefits — ${L.reference}`,
        rules: [
          `Allowed amounts as adjudicated by the payer.`,
          `Each line total is units × allowed amount.`,
          `Every claim reference below is unique to one line. Dates are year-month-day.`,
        ],
        unitWord: "units",
        descriptions: ["Office visit", "Diagnostic imaging", "Lab panel",
          "Procedure", "Follow-up", "Supplies"],
        defectPool: ["Duplicate reference", "Amount doesn't match source", "Date format mismatch",
          "Transposed digits", "Total ≠ qty × rate"],
        decoyNote: "Correct. A single $5,000.00 line is unusual but it is exactly what the EOB allowed — flagging it costs precision.",
      });

    case "review_intake":
      return buildReview("review_intake", seed, {
        title: "A client intake packet",
        docHeading: `Intake summary — ${L.company}`,
        filler: [
          `Intake was completed by ${L.otherName} and countersigned the same day.`,
          `Supporting documents were received and logged under reference ${L.reference}.`,
          `No conflict of interest was identified against our existing client list.`,
          `A follow-up call was scheduled for the week after intake.`,
          `The client confirmed a preferred contact time of late afternoon.`,
          `The file was opened and assigned to the duty caseworker.`,
        ],
        parts: [
          {
            pair: [
              `The client is ${L.contactName}, reachable on the contact number recorded for this matter.`,
              `${L.contactFirst} ${LAST_SWAP(L)} confirmed by email that the figures in this summary are accurate.`,
            ],
            reason: "Name doesn't match earlier",
            why: `The client is named ${L.contactName} earlier and ${L.contactFirst} ${LAST_SWAP(L)} later. One of them is wrong, and it changes who confirmed the figures.`,
          },
          {
            pair: [
              `The total amount claimed is ${L.amountPretty}.`,
              `That total is made up of $${Math.floor(L.amount / 2).toLocaleString("en-US")}.00 in direct losses and $600.00 in costs.`,
            ],
            reason: "Amount doesn't add up",
            why: `The parts given do not sum to the total claimed.`,
          },
        ],
        trapMessage: `The client writes: "Just to confirm — the total we're claiming is $${(L.amount + 1500).toLocaleString("en-US")}.00, isn't it?"`,
        trapQuestion: "What does the document actually say the total claimed is?",
        trapOptions: [
          L.amountPretty,
          `$${(L.amount + 1500).toLocaleString("en-US")}.00`,
          `$${Math.floor(L.amount / 2).toLocaleString("en-US")}.00`,
          "The document does not say",
        ],
        trapAcceptIndex: 0,
        trapWhy: "The client asserted a figure the document contradicts. Agreeing with a client who is wrong about their own file is the failure mode this item exists to catch.",
      });
    case "review_casefacts":
      return buildReview("review_casefacts", seed, {
        title: "A case fact summary",
        docHeading: `Case summary — ${L.reference}`,
        filler: [
          `This matter concerns a contract between ${L.company} and the respondent.`,
          `${L.contactName} signed on behalf of ${L.company}.`,
          `Performance was due within thirty days of signature.`,
          `Correspondence following termination is held under reference ${L.reference}.`,
          `${L.otherName} has confirmed that no further payments were received.`,
          `Counsel's opinion has been requested and is not yet received.`,
        ],
        parts: [
          {
            pair: [
              `The agreement was signed on ${L.duePretty}.`,
              `The agreement was terminated by notice on a date two weeks earlier than the signature date given for it.`,
            ],
            reason: "Date contradicts earlier",
            why: "The agreement is said to have been terminated before it was signed, which cannot be true.",
          },
          {
            pair: [
              `The respondent made a part payment of $${Math.floor(L.amount / 4).toLocaleString("en-US")}.00 one month after signature.`,
              `The total outstanding is recorded as ${L.amountPretty}, the full original sum.`,
            ],
            reason: "Amount doesn't add up",
            why: "A part payment was made, yet the outstanding total is unchanged from the full amount.",
          },
        ],
        trapMessage: `The client writes: "The contract was signed in January, wasn't it? That's what I remember."`,
        trapQuestion: "What signature date does the document give?",
        trapOptions: [
          "January 2026",
          L.duePretty,
          "The document does not give a signature date",
          L.meetingPretty,
        ],
        trapAcceptIndex: 1,
        trapWhy: "The client misremembered. The document is the record, and repeating the client's version back to them puts a wrong date into the file.",
      });
    case "review_policy":
      return buildReview("review_policy", seed, {
        title: "A policy extract and a request",
        docHeading: `${L.company} — refund and cancellation policy (extract)`,
        filler: [
          `Cancellations made more than fourteen days before the service date receive a full refund.`,
          `Cancellations made within fourteen days receive a fifty percent refund.`,
          `No refund is available once the service has commenced.`,
          `This policy applies to all bookings taken after ${L.duePretty}.`,
          `Requests must be made in writing and quote the booking reference.`,
          `The booking under discussion is reference ${L.reference}, taken after this policy came into effect.`,
        ],
        parts: [
          {
            pair: [
              `Refunds are processed to the original payment method within ten working days.`,
              `Where a refund is approved, it is issued within thirty working days of approval.`,
            ],
            reason: "Amount doesn't add up",
            why: "The document gives two different refund processing times, ten working days and thirty.",
          },
          {
            pair: [
              `Deposits are non-refundable in all circumstances.`,
              `Where a full refund applies, the deposit is returned as part of that refund.`,
            ],
            reason: "Status contradicts earlier",
            why: "Deposits are said to be non-refundable in all circumstances, and then to be returned as part of a full refund.",
          },
        ],
        trapMessage: `The client writes: "They cancelled twenty days out, so they get everything back including the deposit — that's right, isn't it?"`,
        trapQuestion: "According to this document, what is the position on the deposit?",
        trapOptions: [
          "The deposit is returned — the policy says so for a full refund",
          "The deposit is not returned — the policy says deposits are never refundable",
          "The document contradicts itself and cannot answer this",
          "The deposit is returned only after thirty working days",
        ],
        trapAcceptIndex: 2,
        trapWhy: "Both readings are written down. The competent answer is to say the document contradicts itself and get it decided, not to pick the half that agrees with whoever asked.",
      });

    default:
      // An unknown variant must never be a runtime surprise on the serve path.
      return buildTask("triage_billing", seed, seededTool);
  }
}

/** A visibly different surname, for the intake packet's name-change defect. */
function LAST_SWAP(L: SeededLiterals): string {
  const alt = ["Whitfield", "Boyd", "Prescott", "Vaughn", "Bright"];
  return alt.find((a) => a !== L.contactLast) || "Boyd";
}
