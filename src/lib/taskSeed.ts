/**
 * Deterministic literals for a task brief.
 *
 * The defect STRUCTURE of every task variant is hand-authored, so a person can
 * audit it. Only the literals — names, dates, amounts, reference numbers, times
 * — rotate, from a seed stored on the interview row.
 *
 * That split is deliberate and it comes from a receipt. StaffVA's English test
 * shipped 100 hand-authored grammar items of which 17 had two defensible
 * answers, 52% of candidates got them wrong, and 23 of 45 rejected candidates
 * would have passed on regrade. A generated task would have the same defect
 * rate with none of the auditability. So: humans check the structure, the seed
 * defeats the shared answer key.
 *
 * Same seed in, same brief out, forever — an appeal has to be re-runnable, and
 * the checker recomputes the key from (variant, seed) rather than trusting
 * anything the client sent back.
 */

/** mulberry32 — small, fast, and stable across Node versions. */
function rngFrom(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A seeded generator for a variant, for callers that need to rotate STRUCTURE
 * and not just literals.
 *
 * Rotating the literals alone is not enough and we proved it: with a fixed
 * defect layout, one memorised submission scored 100% on every seed of all
 * three `review` variants. If the same sentences are always wrong for the same
 * reasons, the seed changes the names on a shared answer key and nothing else.
 * So which rows carry defects, which defects they carry, and where the
 * contradictions sit in a document are all drawn from here.
 */
export function rngFor(variant: string, seed: string): () => number {
  return rngFrom(`${variant}:${seed}:structure`);
}

/** Fisher-Yates over a copy, using a seeded rng. */
export function shuffled<T>(rnd: () => number, items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A 12-character base32 seed. Generated once at serve; never derived from
 * the interview id, which sits in the candidate's own URL bar. */
export function newTaskSeed(): string {
  const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

// ── Pools ────────────────────────────────────────────────────────────────
// Names are common US business names. Reference numbers are authored without
// the confusable glyphs O/0, I/1 and S/5 so a candidate who reads carefully is
// never punished for our font.

const FIRST = ["Denise", "Marcus", "Priya", "Alan", "Rochelle", "Tomas", "Nadia",
  "Gregory", "Helen", "Victor", "Camille", "Desmond", "Rhea", "Warren", "Lorna"];
const LAST = ["Harper", "Whitfield", "Castellanos", "Boyd", "Nakamura", "Ellison",
  "Prescott", "Vaughn", "Okafor", "Lindqvist", "Ferraro", "Bright", "Mensah"];
const COMPANY = ["Bluecrest Dental", "Ardent Legal Group", "Northway Logistics",
  "Halden & Roe", "Sunridge Property Co", "Kestrel Marketing", "Fairbanks Clinic",
  "Trellis Home Services", "Ironwood Consulting", "Marlow Veterinary"];

/**
 * US timezones paired with a date where the DST answer differs from the
 * naive one. Manila is UTC+8 year-round and observes no DST, which is exactly
 * why this is the single most US-specific thing in the job and why nothing in
 * either app has ever tested it.
 */
const ZONES = [
  { label: "Eastern", abbrevDst: "EDT", abbrevStd: "EST", dstOffset: -4, stdOffset: -5 },
  { label: "Central", abbrevDst: "CDT", abbrevStd: "CST", dstOffset: -5, stdOffset: -6 },
  { label: "Pacific", abbrevDst: "PDT", abbrevStd: "PST", dstOffset: -7, stdOffset: -8 },
];

/** US DST in 2026: 8 March to 1 November. */
function isUsDst(iso: string): boolean {
  return iso >= "2026-03-08" && iso < "2026-11-01";
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

function pick<T>(rnd: () => number, pool: T[]): T {
  return pool[Math.floor(rnd() * pool.length)];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export interface SeededLiterals {
  contactFirst: string;
  contactLast: string;
  contactName: string;
  company: string;
  /** The due date, as ISO and as it appears in the brief prose. */
  dueIso: string;
  duePretty: string;
  amount: number;
  amountPretty: string;
  reference: string;
  /** The meeting: stated in the client's US zone, answered in Manila time. */
  zoneLabel: string;
  zoneAbbrev: string;
  meetingIso: string;
  meetingPretty: string;
  meetingHour24: number;
  /** The four radio options, and which index is right. */
  manilaOptions: string[];
  manilaCorrectIndex: number;
  /** Second name used by variants that need a person to escalate to. */
  otherName: string;
}

/**
 * Convert a wall-clock time in a US zone to Manila (UTC+8), returning the
 * weekday-relative label a candidate would actually write.
 */
function toManila(
  meetingIso: string,
  hour24: number,
  utcOffset: number
): { label: string; dayShift: number; hour: number } {
  const utcHour = hour24 - utcOffset;
  const manilaHourRaw = utcHour + 8;
  const dayShift = Math.floor(manilaHourRaw / 24);
  const hour = ((manilaHourRaw % 24) + 24) % 24;
  const d = new Date(meetingIso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + dayShift);
  const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday",
    "Friday", "Saturday"][d.getUTCDay()];
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? "AM" : "PM";
  return { label: `${h12}:00 ${ampm} ${weekday}`, dayShift, hour };
}

export function seededLiterals(variant: string, seed: string): SeededLiterals {
  const rnd = rngFrom(`${variant}:${seed}`);

  const contactFirst = pick(rnd, FIRST);
  const contactLast = pick(rnd, LAST);
  let otherFirst = pick(rnd, FIRST);
  if (otherFirst === contactFirst) otherFirst = FIRST[(FIRST.indexOf(otherFirst) + 1) % FIRST.length];
  const company = pick(rnd, COMPANY);

  // A due date inside DST so the meeting conversion has a real DST answer.
  const month = 3 + Math.floor(rnd() * 6); // April..September (0-indexed 3..8)
  const day = 3 + Math.floor(rnd() * 24);
  const dueIso = `2026-${pad(month + 1)}-${pad(day)}`;
  const duePretty = `${MONTHS[month]} ${day}, 2026`;

  const amount = 1200 + Math.floor(rnd() * 8000);
  const amountPretty = `$${amount.toLocaleString("en-US")}.00`;

  const REF_ALPHA = "ABCDEFGHJKMNPQRTUVWXYZ"; // no O, I, S
  const REF_NUM = "234679"; // no 0, 1, 5
  const reference =
    Array.from({ length: 3 }, () => REF_ALPHA[Math.floor(rnd() * REF_ALPHA.length)]).join("") +
    "-" +
    Array.from({ length: 5 }, () => REF_NUM[Math.floor(rnd() * REF_NUM.length)]).join("");

  // The meeting, a few days after the due date, always inside US DST.
  const zone = pick(rnd, ZONES);
  const meetDay = Math.min(day + 2 + Math.floor(rnd() * 5), 27);
  const meetingIso = `2026-${pad(month + 1)}-${pad(meetDay)}`;
  const meetingHour24 = [13, 14, 15, 16, 9, 10][Math.floor(rnd() * 6)];
  const dst = isUsDst(meetingIso);
  const trueOffset = dst ? zone.dstOffset : zone.stdOffset;
  const naiveOffset = dst ? zone.stdOffset : zone.dstOffset;

  const correct = toManila(meetingIso, meetingHour24, trueOffset);
  const ignoredDst = toManila(meetingIso, meetingHour24, naiveOffset);
  // Subtracting instead of adding the Manila offset — the classic direction slip.
  const wrongDirection = toManila(meetingIso, meetingHour24, trueOffset + 16);
  // Right hour, wrong half of the day.
  const flipped = (() => {
    const h = (correct.hour + 12) % 24;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const ampm = h < 12 ? "AM" : "PM";
    return { label: `${h12}:00 ${ampm} ${correct.label.split(" ").slice(-1)[0]}` };
  })();

  // Deduplicate: two identical option labels would make the item unanswerable.
  const seen = new Set<string>();
  const raw = [correct.label, ignoredDst.label, wrongDirection.label, flipped.label];
  const options: string[] = [];
  for (const label of raw) {
    if (seen.has(label)) continue;
    seen.add(label);
    options.push(label);
  }
  // If collisions collapsed the set, pad with unambiguous fillers.
  let fillerHour = 1;
  while (options.length < 4) {
    const h12 = fillerHour % 12 === 0 ? 12 : fillerHour % 12;
    const label = `${h12}:00 ${fillerHour < 12 ? "AM" : "PM"} ${correct.label.split(" ").slice(-1)[0]}`;
    if (!seen.has(label)) { seen.add(label); options.push(label); }
    fillerHour++;
  }
  // Stable shuffle from the same rng, so the correct answer is not always first.
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }

  const meetD = new Date(meetingIso + "T00:00:00Z");
  const meetWeekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday",
    "Friday", "Saturday"][meetD.getUTCDay()];
  const mh12 = meetingHour24 % 12 === 0 ? 12 : meetingHour24 % 12;

  return {
    contactFirst,
    contactLast,
    contactName: `${contactFirst} ${contactLast}`,
    company,
    dueIso,
    duePretty,
    amount,
    amountPretty,
    reference,
    zoneLabel: zone.label,
    zoneAbbrev: dst ? zone.abbrevDst : zone.abbrevStd,
    meetingIso,
    meetingPretty: `${meetWeekday} ${MONTHS[month]} ${meetDay} at ${mh12}:00 ${meetingHour24 < 12 ? "AM" : "PM"}`,
    meetingHour24,
    manilaOptions: options,
    manilaCorrectIndex: options.indexOf(correct.label),
    otherName: otherFirst,
  };
}
