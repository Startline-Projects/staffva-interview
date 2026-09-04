/**
 * Scoring for the Interview 2 task. Pure, synchronous, no vendor.
 *
 * Three properties this file exists to guarantee:
 *
 * 1. The key is RECOMPUTED from (variant, seed). Nothing the client sent is
 *    trusted as an answer, and a result can be re-derived months later from two
 *    stored strings — which is what makes an appeal answerable.
 * 2. Normalization is generous where format is not the skill. Rejecting a
 *    competent person because they wrote 04/03/2026 instead of 2026-04-03 is
 *    the English-test defect with new content: 17 of 100 grammar items had two
 *    defensible answers and 23 of 45 rejected candidates would have passed on
 *    regrade. Where the format IS the skill, the field says so on screen.
 * 3. Every point carries a `why`, so a recruiter reads "missed the duplicate
 *    reference on row 6" rather than a number. That explainability is the whole
 *    argument for scoring this in code instead of asking a model.
 */
import { buildTask, type TaskAnswerKey } from "@/lib/taskBank";

export interface TaskSubmission {
  /** field id or item id → the candidate's answer. */
  [id: string]: string | { flagged?: boolean; corrected?: string; reason?: string } | undefined;
}

export interface ItemVerdict {
  id: string;
  got: string;
  expected: string;
  correct: boolean;
  points: number;
  earned: number;
  why: string;
}

export interface TaskScore {
  pct: number;
  earned: number;
  maxPoints: number;
  verdicts: ItemVerdict[];
  /** Short, recruiter-facing summary lines. */
  missed: string[];
}

// ── Normalizers ──────────────────────────────────────────────────────────

const TITLES = /\b(mr|mrs|ms|miss|dr|prof|sir|madam)\b\.?/g;

export function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(TITLES, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"];

/**
 * Parse the formats a competent person actually writes, and only those.
 * Deliberately does NOT accept a bare "3/4" or a two-digit year: guessing a
 * century or a day/month order we were not given would manufacture a wrong
 * answer out of an ambiguous one.
 */
export function normDate(s: string): string | null {
  const t = s.trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ");
  if (!t) return null;

  // 2026-04-03 | 2026-4-3 | 2026/04/03
  let m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);

  // 04/03/2026 | 4-3-2026  (US month-first, which is what the brief uses)
  m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return iso(+m[3], +m[1], +m[2]);

  // 3 april 2026
  m = t.match(/^(\d{1,2}) ([a-z]+) (\d{4})$/);
  if (m) {
    const mi = MONTH_NAMES.findIndex((n) => n.startsWith(m![2].slice(0, 3)));
    if (mi >= 0) return iso(+m[3], mi + 1, +m[1]);
  }

  // april 3 2026
  m = t.match(/^([a-z]+) (\d{1,2}) (\d{4})$/);
  if (m) {
    const mi = MONTH_NAMES.findIndex((n) => n.startsWith(m![1].slice(0, 3)));
    if (mi >= 0) return iso(+m[3], mi + 1, +m[2]);
  }

  return null;
}

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function normAmount(s: string): string | null {
  const t = s.replace(/[$,\s]/g, "").replace(/usd/gi, "");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t).toFixed(2);
}

/**
 * References are compared case- and separator-insensitively, with the
 * confusable glyphs folded. The bank authors references without O/0, I/1 or
 * S/5 in the first place; this fold is belt-and-braces so nobody loses a point
 * to a font.
 */
export function normRef(s: string): string {
  return s
    .toUpperCase()
    .replace(/[\s\-_.]/g, "")
    .replace(/O/g, "0")
    .replace(/I/g, "1")
    .replace(/S/g, "5");
}

function asText(v: TaskSubmission[string]): string {
  return typeof v === "string" ? v : "";
}

function asRow(v: TaskSubmission[string]): { flagged?: boolean; corrected?: string; reason?: string } {
  return v && typeof v === "object" ? v : {};
}

// ── The scorer ───────────────────────────────────────────────────────────

export function scoreTask(
  variant: string,
  seed: string,
  submission: TaskSubmission,
  seededTool: string | null = null
): TaskScore {
  const { keys } = buildTask(variant, seed, seededTool);
  const verdicts: ItemVerdict[] = [];
  const missed: string[] = [];
  let earned = 0;
  let maxPoints = 0;

  for (const key of keys) {
    switch (key.type) {
      case "email_extract": {
        for (const f of key.fields) {
          const raw = asText(submission[f.id]);
          let ok = false;
          let expected = f.accept[0];
          switch (f.compare) {
            case "name":
              ok = f.accept.some((a) => normName(a) === normName(raw));
              break;
            case "date": {
              const got = normDate(raw);
              ok = !!got && f.accept.some((a) => normDate(a) === got);
              break;
            }
            case "amount": {
              const got = normAmount(raw);
              ok = !!got && f.accept.some((a) => normAmount(a) === got);
              expected = normAmount(f.accept[0]) ?? f.accept[0];
              break;
            }
            case "ref":
              ok = f.accept.some((a) => normRef(a) === normRef(raw));
              break;
            default:
              ok = f.accept.some((a) => a.trim() === raw.trim());
          }
          maxPoints += f.points;
          if (ok) earned += f.points;
          else missed.push(labelFor(f.id));
          verdicts.push({
            id: f.id, got: raw || "(blank)", expected, correct: ok,
            points: f.points, earned: ok ? f.points : 0,
            why: ok ? "Correct." : `Expected ${expected}.`,
          });
        }
        break;
      }

      case "queue_sort": {
        for (const it of key.items) {
          const raw = asText(submission[it.id]).trim();
          const ok = it.accept.includes(raw);
          maxPoints += it.points;
          if (ok) earned += it.points;
          else missed.push(`queue item ${it.id}`);
          verdicts.push({
            id: it.id, got: raw || "(no answer)", expected: it.accept.join(" or "),
            correct: ok, points: it.points, earned: ok ? it.points : 0, why: it.why,
          });
        }
        break;
      }

      case "row_check": {
        // F1 over the flag decision, then the quality of the corrections.
        let tp = 0, fp = 0, fn = 0, corrected = 0;
        for (const r of key.rows) {
          const got = asRow(submission[r.id]);
          const flagged = got.flagged === true;
          if (r.defect && flagged) {
            tp++;
            // Every comparison here must REQUIRE a parse on both sides.
            // normAmount returns null for anything non-numeric, so a bare
            // `normAmount(a) === normAmount(c)` was true whenever the expected
            // value was a reference and the candidate's box was blank — null
            // equals null — and a blank correction scored full marks. Same
            // trap for normDate.
            const c = (got.corrected || "").trim();
            const valueOk =
              !r.correctedAccept ||
              (c.length > 0 &&
                r.correctedAccept.some((a) => {
                  if (a.trim() === c) return true;
                  const aAmt = normAmount(a);
                  if (aAmt !== null && aAmt === normAmount(c)) return true;
                  const aDate = normDate(a);
                  if (aDate !== null && aDate === normDate(c)) return true;
                  // normRef never returns null, so it is only meaningful when
                  // the expected value actually looks like a reference.
                  if (/[A-Za-z]/.test(a) && normRef(a) === normRef(c)) return true;
                  return false;
                }));
            const reasonOk = !r.reason || got.reason === r.reason;
            if (valueOk && reasonOk) corrected++;
            verdicts.push({
              id: r.id, got: `flagged (${got.reason || "no reason"}, "${got.corrected || ""}")`,
              expected: `${r.reason} → ${(r.correctedAccept || ["—"])[0]}`,
              correct: valueOk && reasonOk, points: 1, earned: valueOk && reasonOk ? 1 : 0,
              why: r.why,
            });
          } else if (r.defect && !flagged) {
            fn++;
            missed.push(`row ${r.id} (${r.reason})`);
            verdicts.push({
              id: r.id, got: "not flagged", expected: r.reason || "defect",
              correct: false, points: 1, earned: 0, why: r.why,
            });
          } else if (!r.defect && flagged) {
            fp++;
            missed.push(`row ${r.id} flagged but correct`);
            verdicts.push({
              id: r.id, got: "flagged", expected: "leave alone",
              correct: false, points: 0, earned: 0, why: r.why,
            });
          }
        }
        const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
        const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
        const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
        const corrRate = key.defectCount > 0 ? corrected / key.defectCount : 0;
        // This block is scored as a proportion, then folded into the same
        // points scale as everything else so a mixed task still sums cleanly.
        const blockPoints = 10;
        maxPoints += blockPoints;
        earned += blockPoints * (0.6 * f1 + 0.4 * corrRate);
        break;
      }

      case "doc_flags": {
        const flaggedIdx = new Set<number>();
        const reasons = new Map<number, string>();
        for (const [k, v] of Object.entries(submission)) {
          const m = k.match(/^sent_(\d+)$/);
          if (!m) continue;
          const row = asRow(v);
          if (row.flagged) {
            flaggedIdx.add(Number(m[1]));
            if (row.reason) reasons.set(Number(m[1]), row.reason);
          }
        }
        const claimed = new Set<number>();
        for (const inc of key.inconsistencies) {
          maxPoints += 2;
          const hit = inc.acceptIndices.find((i) => flaggedIdx.has(i));
          if (hit !== undefined) {
            claimed.add(hit);
            earned += 1;
            const reasonOk = reasons.get(hit) === inc.reason;
            if (reasonOk) earned += 1;
            verdicts.push({
              id: `inc_${inc.acceptIndices[0]}`,
              got: `sentence ${hit + 1} (${reasons.get(hit) || "no reason"})`,
              expected: `sentence ${inc.acceptIndices.map((i) => i + 1).join(" or ")} — ${inc.reason}`,
              correct: reasonOk, points: 2, earned: reasonOk ? 2 : 1, why: inc.why,
            });
          } else {
            missed.push(inc.reason.toLowerCase());
            verdicts.push({
              id: `inc_${inc.acceptIndices[0]}`, got: "not found",
              expected: `sentence ${inc.acceptIndices.map((i) => i + 1).join(" or ")} — ${inc.reason}`,
              correct: false, points: 2, earned: 0, why: inc.why,
            });
          }
        }
        // Flagging clean sentences costs, or "flag everything" would score full.
        for (const i of flaggedIdx) {
          if (claimed.has(i)) continue;
          const belongs = key.inconsistencies.some((inc) => inc.acceptIndices.includes(i));
          if (belongs) continue;
          earned -= key.penaltyPerFalsePositive;
          verdicts.push({
            id: `fp_${i}`, got: `sentence ${i + 1} flagged`, expected: "leave alone",
            correct: false, points: 0, earned: -key.penaltyPerFalsePositive,
            why: "This sentence does not contradict anything else in the document.",
          });
        }
        break;
      }

      case "fact_pick": {
        const raw = asText(submission["fact_pick"]).trim();
        const ok = raw === String(key.acceptIndex);
        maxPoints += key.points;
        if (ok) earned += key.points;
        else missed.push("agreed with the client against the document");
        verdicts.push({
          id: "fact_pick", got: raw === "" ? "(no answer)" : `option ${Number(raw) + 1}`,
          expected: `option ${key.acceptIndex + 1}`, correct: ok,
          points: key.points, earned: ok ? key.points : 0, why: key.why,
        });
        break;
      }
    }
  }

  // A negative total is possible on doc_flags if somebody flags everything.
  // Clamp for display; the raw earned stays in the stored detail.
  const clamped = Math.max(0, earned);
  const pct = maxPoints > 0 ? Math.round((clamped / maxPoints) * 10000) / 100 : 0;

  return {
    pct: Math.min(100, pct),
    earned: Math.round(earned * 100) / 100,
    maxPoints,
    verdicts,
    missed,
  };
}

function labelFor(id: string): string {
  const map: Record<string, string> = {
    contact_name: "the contact's name",
    due_date: "the due date",
    amount: "the amount",
    reference: "the reference number",
    meeting_time_manila: "the Manila meeting time",
  };
  return map[id] || id;
}
