/**
 * Fixed definitions for the bounded TypeSafe pilot: the model, the three questions asked about
 * each labeled pair, the decision thresholds, and the code that turns probabilities into a
 * verdict. Wording and thresholds were fixed before any pair was sent and are not tuned against
 * results; changing them means a new, separately reported run.
 *
 * Pure functions only: no network, no file access.
 */

export const MODEL = 'jev-latest';

// Decision thresholds, declared up front. The same values apply to every split and label.
export const THRESHOLDS = {
  high: 0.9, // confident enough to flag
  review: 0.4, // uncertain enough to send to a human
  sameAnswerMin: 0.8, // a duplicate also needs the same correct answer
};

export const QUESTIONS = {
  same_fact: {
    type: 'noul',
    instructions:
      'Do question A and question B ask for the same fact, so that one of them is redundant given the other?',
    criteria: {
      true: 'Both questions ask for the same piece of information and have the same correct answer. They differ only in wording, choice order or distractor choices.',
      false:
        'The questions ask about different facts, even if they share a topic, wording, numbers or a template. A question that is the inverse of the other also counts as different.',
    },
  },
  same_answer: {
    type: 'noul',
    instructions:
      'Is the correct answer to question A the same as the correct answer to question B?',
    criteria: {
      true: 'The two correct answers refer to the same thing or value, ignoring formatting and wording.',
      false: 'The two correct answers are different things or values.',
    },
  },
  leakage: {
    type: 'noul',
    instructions:
      "Does either question's wording or correct answer give away the correct answer to the other question?",
    criteria: {
      true: "The correct answer to one question is stated in, or can be read directly off, the other question's wording, or the questions are closely linked facts with the same answer, so seeing one lets a player answer the other.",
      false:
        'Knowing one question and its answer would not help a player answer the other. They are independent facts, even if they are on the same topic.',
    },
  },
};

export const stripSetSuffix = (text) => text.replace(/\s*\(set \d+\)\s*$/, '');

const view = (q) => ({
  question: q.question,
  choices: q.choices,
  correct_answer: q.choices[q.correctIndex],
});

/** State sent to the model: neutral A/B names only. No ids, labels, categories or splits. */
export function buildState(candidate, existing) {
  return { question_a: view(candidate), question_b: view(existing) };
}

export function buildRequest(candidate, existing) {
  return { model: MODEL, state: buildState(candidate, existing), questions: QUESTIONS };
}

/**
 * Code-owned rule for intentional seed copies: identical after removing a trailing "(set N)",
 * same choices and answer, and at least one side actually carries the suffix.
 */
export function isSeedVariantByRule(candidate, existing) {
  const suffixed = (q) => stripSetSuffix(q.question) !== q.question;
  return (
    (suffixed(candidate) || suffixed(existing)) &&
    stripSetSuffix(candidate.question) === stripSetSuffix(existing.question) &&
    JSON.stringify(candidate.choices) === JSON.stringify(existing.choices) &&
    candidate.correctIndex === existing.correctIndex
  );
}

/**
 * Pull the three probabilities out of a systemone response. Returns null unless every question
 * has a `noul` answer that is a finite number in [0, 1]: a missing, mistyped, NaN or
 * out-of-range value makes the whole response unusable.
 */
export function readProbabilities(response) {
  const out = {};
  for (const name of Object.keys(QUESTIONS)) {
    const a = response?.answers?.[name];
    if (!a || a.type !== 'noul') return null;
    if (typeof a.noul !== 'number' || !Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1)
      return null;
    out[name] = a.noul;
  }
  return out;
}

/**
 * Decides whether a request counts as successful. Only an HTTP 200 whose body carries all three
 * valid probabilities is recorded as ok; anything else is a failure with a stated reason and is
 * re-sent on the next run.
 */
export function judgeResponse(status, json) {
  if (status !== 200) return { ok: false, probs: null, reason: `http-${status}` };
  const probs = readProbabilities(json);
  if (probs === null) return { ok: false, probs: null, reason: 'invalid-probabilities' };
  return { ok: true, probs, reason: null };
}

/**
 * Verdict from probabilities, in priority order. Duplicates outrank leakage because a duplicate
 * trivially leaks its own answer.
 */
export function verdictFor(probs, { seedVariantByRule = false, thresholds = THRESHOLDS } = {}) {
  if (seedVariantByRule) return 'seed_variant';
  if (probs === null) return 'error';
  const t = thresholds;
  if (probs.same_fact >= t.high && probs.same_answer >= t.sameAnswerMin) return 'duplicate';
  if (probs.leakage >= t.high) return 'leakage';
  if (probs.same_fact >= t.review || probs.leakage >= t.review) return 'review';
  return 'distinct';
}

/** Deterministic stratified sample: first, middle and last dev pair of each label (in file order). */
export function samplePairIds(pairs, labels) {
  const ids = [];
  for (const label of labels) {
    const subset = pairs.filter((p) => p.split === 'dev' && p.label === label);
    if (subset.length === 0) continue;
    const picks = new Set([0, Math.floor(subset.length / 2), subset.length - 1]);
    for (const i of [...picks].sort((a, b) => a - b)) ids.push(subset[i].id);
  }
  return ids;
}
