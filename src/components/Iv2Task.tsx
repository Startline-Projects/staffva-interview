"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { TaskBrief, BriefBlock } from "@/lib/taskBank";
import "@/app/landing.css";
import "@/app/atlas-auth.css";

/**
 * The Interview 2 performance task.
 *
 * One shell, four block renderers. Text in, text out — no upload, no install,
 * no screen share, no drag interaction, and nothing that needs a fast uplink,
 * because the candidate is on a laptop in the Philippines on a connection we do
 * not control and the proctor stream is already using half of it.
 *
 * Two rules that look like details and are not:
 *
 *  - The timer here is DISPLAY ONLY. It is never sent, and the server stamps
 *    served_at and submitted_at itself. A clock the client can pause is not
 *    evidence of anything.
 *  - The deadline is soft. It turns amber, then it says the time is up, and
 *    then it accepts the submission anyway. Hard-cutting someone mid-answer on
 *    a connection that stalled punishes the connection, not the candidate; the
 *    lateness is recorded and a human can weigh it.
 */

type Answer = string | { flagged?: boolean; corrected?: string; reason?: string };

export default function Iv2Task({
  token,
  interviewId,
  brief,
  servedAt,
  confident,
  onDone,
}: {
  token: string;
  interviewId: string;
  brief: TaskBrief;
  servedAt: string | null;
  confident: boolean;
  onDone: (outcome: "submitted" | "abandoned") => void;
}) {
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmSkip, setConfirmSkip] = useState(false);

  const startedRef = useRef<number>(
    servedAt ? new Date(servedAt).getTime() : Date.now()
  );
  const eventsRef = useRef<{ kind: string; at: string }[]>([]);
  const flushRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const set = useCallback((id: string, value: Answer) => {
    setAnswers((a) => ({ ...a, [id]: value }));
  }, []);

  const patchRow = useCallback((id: string, patch: Partial<Exclude<Answer, string>>) => {
    setAnswers((a) => {
      const prev = typeof a[id] === "object" && a[id] ? (a[id] as Record<string, unknown>) : {};
      return { ...a, [id]: { ...prev, ...patch } };
    });
  }, []);

  // ── Elapsed clock, from the SERVER's serve stamp ──
  useEffect(() => {
    const tick = () => setElapsed(Math.floor((Date.now() - startedRef.current) / 1000));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  // ── Focus / paste telemetry ──
  // Batched, fire-and-forget, and it goes to its own table. It never scores
  // anything and it never locks anyone out; it exists so a person reviewing a
  // flagged session has context. See the route for why that boundary matters.
  useEffect(() => {
    const push = (kind: string) => {
      eventsRef.current.push({ kind, at: new Date().toISOString() });
    };
    const onBlur = () => push("blur");
    const onFocus = () => push("focus");
    const onVis = () =>
      push(document.hidden ? "visibility_hidden" : "visibility_visible");
    const onPaste = () => push("paste");

    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    document.addEventListener("paste", onPaste);

    const flush = () => {
      if (!eventsRef.current.length) return;
      const batch = eventsRef.current.splice(0, 40);
      fetch("/api/interview/task/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, interviewId, events: batch }),
        keepalive: true,
      }).catch(() => {});
    };
    flushRef.current = setInterval(flush, 15_000);

    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
      document.removeEventListener("paste", onPaste);
      if (flushRef.current) clearInterval(flushRef.current);
      flush();
    };
  }, [token, interviewId]);

  async function handleSubmit() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/interview/task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, interviewId, action: "submit", submission: answers }),
      });
      if (!res.ok && res.status !== 409) {
        setError("We couldn't save your answers. Try once more.");
        setBusy(false);
        return;
      }
      onDone("submitted");
    } catch {
      setError("We couldn't reach the server. Check your connection and try again.");
      setBusy(false);
    }
  }

  async function handleSkip() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/interview/task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, interviewId, action: "abandon" }),
      });
    } catch {
      /* Going back to the interview matters more than recording why. */
    }
    onDone("abandoned");
  }

  const left = brief.softSeconds - elapsed;
  const clock =
    left >= 0
      ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left`
      : "Time's up — finish your thought";
  const clockClass = left < 0 ? "over" : left <= 60 ? "soon" : "";

  return (
    <div className="iv2-task">
      <div className="test-q-tag">{brief.title}</div>
      <p className="iv2-task-intro">{brief.intro}</p>

      {!confident && (
        <p className="iv2-task-intro" style={{ color: "rgba(214,242,77,0.75)" }}>
          We matched your role to a general assistant task. If that&apos;s not the work you
          do, say so when the interview resumes — it will not count against you.
        </p>
      )}

      {brief.blocks.map((block, i) => (
        <Block
          key={i}
          block={block}
          answers={answers}
          set={set}
          patchRow={patchRow}
        />
      ))}

      {error && (
        <div className="field-error-text" role="alert" style={{ display: "block", marginTop: 12 }}>
          <span className="err-msg">{error}</span>
        </div>
      )}

      <div className="iv2-task-footer">
        {confirmSkip ? (
          <span style={{ fontSize: 12.5, color: "rgba(251,248,242,0.7)" }}>
            Skip the task and go back to the interview?{" "}
            <button type="button" className="iv2-skip" onClick={handleSkip} disabled={busy}>
              Yes, skip it
            </button>{" "}
            ·{" "}
            <button type="button" className="iv2-skip" onClick={() => setConfirmSkip(false)}>
              Keep going
            </button>
          </span>
        ) : (
          <button type="button" className="iv2-skip" onClick={() => setConfirmSkip(true)}>
            I can&apos;t continue this task
          </button>
        )}
        <span style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span className={`iv2-deadline ${clockClass}`}>{clock}</span>
          <button
            type="button"
            className={`btn-submit${busy ? " loading" : ""}`}
            onClick={handleSubmit}
            disabled={busy}
            style={{ width: "auto", padding: "12px 26px" }}
          >
            <span className="submit-label">Submit and continue</span>
            <span className="spinner" aria-hidden></span>
          </button>
        </span>
      </div>
    </div>
  );
}

// ── Block renderers ──────────────────────────────────────────────────────

function Block({
  block,
  answers,
  set,
  patchRow,
}: {
  block: BriefBlock;
  answers: Record<string, Answer>;
  set: (id: string, v: Answer) => void;
  patchRow: (id: string, patch: Partial<Exclude<Answer, string>>) => void;
}) {
  const text = (id: string) => (typeof answers[id] === "string" ? (answers[id] as string) : "");
  const row = (id: string) =>
    typeof answers[id] === "object" && answers[id]
      ? (answers[id] as Exclude<Answer, string>)
      : {};

  if (block.type === "email_extract") {
    return (
      <div className="iv2-block">
        <div className="iv2-block-heading">{block.heading}</div>
        <div className="iv2-paper">
          {block.prose.map((line, i) => (
            <div key={i} className={`iv2-paper-line${line === "" ? " blank" : ""}`}>
              {line}
            </div>
          ))}
        </div>
        {block.fields.map((f) => (
          <div className="iv2-field" key={f.id}>
            <label className="iv2-field-label" htmlFor={`f_${f.id}`}>
              {f.label}
              {f.hint && <span className="iv2-field-hint">{f.hint}</span>}
            </label>
            {f.kind === "radio" ? (
              <div className="test-mc-options">
                {(f.options || []).map((opt, i) => (
                  <button
                    type="button"
                    key={i}
                    className={`test-mc-option${text(f.id) === String(i) ? " selected" : ""}`}
                    onClick={() => set(f.id, String(i))}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            ) : (
              <input
                id={`f_${f.id}`}
                className={`iv2-input${text(f.id) ? " filled" : ""}`}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={text(f.id)}
                onChange={(e) => set(f.id, e.target.value)}
              />
            )}
          </div>
        ))}
      </div>
    );
  }

  if (block.type === "queue_sort") {
    return (
      <div className="iv2-block">
        <div className="iv2-block-heading">{block.heading}</div>
        <p className="iv2-block-instruction">{block.instruction}</p>
        {block.items.map((item) => (
          <div className="iv2-queue-item" key={item.id}>
            <div className="iv2-queue-text">{item.text}</div>
            <div className="iv2-actions">
              {block.actions.map((a) => (
                <button
                  type="button"
                  key={a}
                  className={`iv2-action${text(item.id) === a ? " selected" : ""}`}
                  onClick={() => set(item.id, a)}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (block.type === "row_check") {
    return (
      <div className="iv2-block">
        <div className="iv2-block-heading">{block.heading}</div>
        <div className="iv2-paper">
          {block.source.map((line, i) => (
            <div key={i} className="iv2-paper-line">
              {line}
            </div>
          ))}
        </div>
        <p className="iv2-block-instruction">{block.instruction}</p>
        <div className="iv2-rows-wrap">
          <table className="iv2-rows">
            <thead>
              <tr>
                <th style={{ width: 34 }}>
                  <span className="sr-only">Wrong?</span>
                </th>
                <th>Ref</th>
                <th>Date</th>
                <th>Description</th>
                <th style={{ textAlign: "right" }}>Qty</th>
                <th style={{ textAlign: "right" }}>Rate</th>
                <th style={{ textAlign: "right" }}>Line total</th>
              </tr>
            </thead>
            <tbody>
              {block.rows.map((r) => {
                const state = row(r.id);
                return (
                  <Fragment key={r.id}>
                    <tr className={state.flagged ? "flagged" : undefined}>
                      <td>
                        <button
                          type="button"
                          className={`iv2-flag${state.flagged ? " on" : ""}`}
                          aria-label={`Flag row ${r.ref} as wrong`}
                          aria-pressed={!!state.flagged}
                          onClick={() => patchRow(r.id, { flagged: !state.flagged })}
                        />
                      </td>
                      <td>{r.ref}</td>
                      <td>{r.date}</td>
                      <td>{r.description}</td>
                      <td style={{ textAlign: "right" }}>{r.qty}</td>
                      <td style={{ textAlign: "right" }}>{r.rate}</td>
                      <td style={{ textAlign: "right" }}>{r.lineTotal}</td>
                    </tr>
                    {state.flagged && (
                      <tr>
                        <td colSpan={7} style={{ padding: 0 }}>
                          <div className="iv2-row-fix">
                            <select
                              className="iv2-select"
                              value={state.reason || ""}
                              onChange={(e) => patchRow(r.id, { reason: e.target.value })}
                              aria-label={`What is wrong with row ${r.ref}`}
                            >
                              <option value="">What&apos;s wrong?</option>
                              {block.reasons.map((x) => (
                                <option key={x} value={x}>
                                  {x}
                                </option>
                              ))}
                            </select>
                            <input
                              className="iv2-input"
                              type="text"
                              placeholder="Corrected value"
                              autoComplete="off"
                              spellCheck={false}
                              value={state.corrected || ""}
                              onChange={(e) => patchRow(r.id, { corrected: e.target.value })}
                              aria-label={`Corrected value for row ${r.ref}`}
                            />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (block.type === "doc_flags") {
    return (
      <div className="iv2-block">
        <div className="iv2-block-heading">{block.heading}</div>
        <p className="iv2-block-instruction">{block.instruction}</p>
        <div className="iv2-doc">
          {block.sentences.map((s, i) => {
            const state = row(`sent_${i}`);
            return (
              <div key={i}>
                <button
                  type="button"
                  className={`iv2-sentence${state.flagged ? " flagged" : ""}`}
                  aria-pressed={!!state.flagged}
                  onClick={() => patchRow(`sent_${i}`, { flagged: !state.flagged })}
                >
                  <span className="iv2-sentence-n">{i + 1}</span>
                  {s}
                </button>
                {state.flagged && (
                  <div className="iv2-sentence-reason">
                    <select
                      className="iv2-select"
                      value={state.reason || ""}
                      onChange={(e) => patchRow(`sent_${i}`, { reason: e.target.value })}
                      aria-label={`What is wrong with sentence ${i + 1}`}
                    >
                      <option value="">What&apos;s wrong with it?</option>
                      {block.reasons.map((x) => (
                        <option key={x} value={x}>
                          {x}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // fact_pick
  return (
    <div className="iv2-block">
      <div className="iv2-block-heading">{block.heading}</div>
      <div className="iv2-paper">{block.message}</div>
      <div className="iv2-field-label" style={{ marginBottom: 10 }}>
        {block.question}
      </div>
      <div className="test-mc-options">
        {block.options.map((opt, i) => (
          <button
            type="button"
            key={i}
            className={`test-mc-option${text("fact_pick") === String(i) ? " selected" : ""}`}
            onClick={() => set("fact_pick", String(i))}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}
