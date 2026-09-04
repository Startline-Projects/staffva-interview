/**
 * Interview 1 — the behavioral bank.
 *
 * Structured, not conversational: each question carries its own prep and
 * answer windows (the Atlas prep/answer mechanic), the candidate sees the
 * question as text, and answers by voice. One interview serves the fixed
 * opener plus one question from each category — five total, matching the
 * Atlas runner — and at most one adaptive follow-up.
 *
 * Authoring rules (the grammar bank's lessons apply to prompts too):
 * workplace-register, culturally neutral, answerable without a formal job
 * history ("work or school" inclusive), nothing that presumes US idiom.
 */

export interface Iv1Question {
  id: string;
  category: "opener" | "conflict" | "problem" | "ambiguity" | "self";
  text: string;
  prepSeconds: number;
  answerSeconds: number;
  /** The question whose answer may earn the interview's ONE follow-up. */
  followUpEligible?: boolean;
}

export const IV1_BANK: Iv1Question[] = [
  {
    id: "opener-1",
    category: "opener",
    text: "To start — tell me a little about yourself and what you're looking for in your next role.",
    prepSeconds: 20,
    answerSeconds: 90,
  },

  {
    id: "conflict-1",
    category: "conflict",
    text: "Describe a time when you disagreed with a teammate or classmate. How did you handle it?",
    prepSeconds: 25,
    answerSeconds: 120,
    followUpEligible: true,
  },
  {
    id: "conflict-2",
    category: "conflict",
    text: "Tell me about a time you received feedback you didn't agree with. What did you do?",
    prepSeconds: 25,
    answerSeconds: 120,
    followUpEligible: true,
  },
  {
    id: "conflict-3",
    category: "conflict",
    text: "Tell me about a time you had to deliver news someone didn't want to hear. How did you approach it?",
    prepSeconds: 25,
    answerSeconds: 120,
    followUpEligible: true,
  },

  {
    id: "problem-1",
    category: "problem",
    text: "Walk me through a problem you solved recently. What made it tricky?",
    prepSeconds: 25,
    answerSeconds: 120,
  },
  {
    id: "problem-2",
    category: "problem",
    text: "Describe a time something went wrong at the last minute. What did you do first?",
    prepSeconds: 25,
    answerSeconds: 120,
  },
  {
    id: "problem-3",
    category: "problem",
    text: "Tell me about a time you had too many things due at once. How did you decide what to do first?",
    prepSeconds: 25,
    answerSeconds: 120,
  },

  {
    id: "ambiguity-1",
    category: "ambiguity",
    text: "You're given a task with an unclear goal. What's the first thing you do?",
    prepSeconds: 20,
    answerSeconds: 90,
  },
  {
    id: "ambiguity-2",
    category: "ambiguity",
    text: "Someone asks you to do something you've never done before. How do you get started?",
    prepSeconds: 20,
    answerSeconds: 90,
  },
  {
    id: "ambiguity-3",
    category: "ambiguity",
    text: "You notice two instructions you were given contradict each other. What do you do?",
    prepSeconds: 20,
    answerSeconds: 90,
  },

  {
    id: "self-1",
    category: "self",
    text: "What's something you've learned about yourself in the last year?",
    prepSeconds: 20,
    answerSeconds: 90,
  },
  {
    id: "self-2",
    category: "self",
    text: "What's a habit you've built that makes you better at your work?",
    prepSeconds: 20,
    answerSeconds: 90,
  },
  {
    id: "self-3",
    category: "self",
    text: "When you're overwhelmed, how do you notice it — and what do you do about it?",
    prepSeconds: 20,
    answerSeconds: 90,
  },
];

/** Deal a plan: the opener, then one random pick per category, in the
 * Atlas order. Returns question ids — the client gets full question data
 * per-turn from the session. */
export function dealIv1Plan(): string[] {
  const pick = (category: Iv1Question["category"]) => {
    const pool = IV1_BANK.filter((q) => q.category === category);
    return pool[Math.floor(Math.random() * pool.length)].id;
  };
  return ["opener-1", pick("conflict"), pick("problem"), pick("ambiguity"), pick("self")];
}

export function iv1QuestionById(id: string): Iv1Question | undefined {
  return IV1_BANK.find((q) => q.id === id);
}
