#!/usr/bin/env node
/**
 * Independent evaluation set: validation, the shortlist stage, and the label-freeze gate.
 *
 * A person other than the pilot's author writes `independent/labels.json` without seeing any
 * TypeSafe output. The shortlist is deterministic and uses no TypeSafe output either, so the
 * labeler can (and must) label every shortlisted pair before anything is scored. `freeze` then
 * records a SHA-256 of the labels; the flow runner refuses to call the API unless the labels on
 * disk still match that hash, and the report checks that no request predates the freeze.
 *
 * Offline: no network, no database, no app code.
 *
 * Usage: node tools/question-dedup-pilot/independent-set.mjs <validate|shortlist|freeze> [--dir DIR]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABELS, buildAnswerGuards, prepare, rankPool } from './evaluate.mjs';
import { isSeedVariantByRule } from './typesafe-questions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Fixed before any independent data exists.
export const SHORTLIST_K = 5;
export const FINAL_LABELS = [...LABELS, 'unrelated'];
export const POSITIVES = ['duplicate_question', 'answer_leakage'];
export const MINIMUMS = {
  candidates: 30,
  duplicate_question: 12,
  answer_leakage: 12,
  related_distinct: 20,
};

const NOT_A_PERSON =
  /claude|anthropic|assistant|chatgpt|gpt|gemini|copilot|\bai\b|\bllm\b|\bbot\b/i;
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export const pairKey = (candidate, existing) => `${candidate}|${existing}`;

/** The label that counts: the resolution for an ambiguous pair, otherwise the labeler's label. */
export const finalLabel = (pair) => (pair.ambiguous ? pair.resolution?.label : pair.label);

export function validateLabels(data, { minimums = MINIMUMS } = {}) {
  const errors = [];
  const warnings = [];
  const nonEmpty = (x) => typeof x === 'string' && x.trim().length > 0;

  if (!nonEmpty(data.labeler)) errors.push('labeler: a named person is required');
  else if (NOT_A_PERSON.test(data.labeler))
    errors.push(`labeler "${data.labeler}" looks like an AI system, not a person`);
  if (data.attestation?.blindToTypeSafe !== true) {
    errors.push(
      'attestation.blindToTypeSafe must be true: the labeler must not have seen any TypeSafe output'
    );
  }

  const byId = new Map();
  for (const q of data.questions ?? []) {
    if (q.example) errors.push(`${q.id}: template example entries must be removed`);
    if (byId.has(q.id)) errors.push(`duplicate question id ${q.id}`);
    byId.set(q.id, q);
    if (!['pool', 'candidate'].includes(q.role))
      errors.push(`${q.id}: role must be "pool" or "candidate"`);
    if (!nonEmpty(q.question) || !Array.isArray(q.choices) || q.choices.length < 2) {
      errors.push(`${q.id}: needs question text and at least 2 choices`);
    } else if (new Set(q.choices).size !== q.choices.length)
      errors.push(`${q.id}: repeated choice text`);
    if (
      !Number.isInteger(q.correctIndex) ||
      q.correctIndex < 0 ||
      q.correctIndex >= (q.choices?.length ?? 0)
    ) {
      errors.push(`${q.id}: correctIndex out of range`);
    }
  }

  const seen = new Set();
  const pairIds = new Set();
  for (const p of data.pairs ?? []) {
    if (p.example) errors.push(`${p.id}: template example entries must be removed`);
    if (pairIds.has(p.id)) errors.push(`duplicate pair id ${p.id}`);
    pairIds.add(p.id);
    const c = byId.get(p.candidate);
    const e = byId.get(p.existing);
    if (!c || c.role !== 'candidate')
      errors.push(`${p.id}: candidate "${p.candidate}" must be a question with role "candidate"`);
    if (!e || e.role !== 'pool')
      errors.push(`${p.id}: existing "${p.existing}" must be a question with role "pool"`);
    const key = pairKey(p.candidate, p.existing);
    if (seen.has(key)) errors.push(`${p.id}: ${key} is labeled twice`);
    seen.add(key);
    if (!FINAL_LABELS.includes(p.label)) errors.push(`${p.id}: unknown label "${p.label}"`);
    if (p.ambiguous) {
      const r = p.resolution;
      if (!r || !FINAL_LABELS.includes(r.label))
        errors.push(`${p.id}: ambiguous pair needs resolution.label before scoring`);
      if (!nonEmpty(r?.resolvedBy))
        errors.push(`${p.id}: ambiguous pair needs resolution.resolvedBy`);
      if (!nonEmpty(r?.rationale))
        errors.push(`${p.id}: ambiguous pair needs a written resolution.rationale`);
      if (nonEmpty(r?.resolvedBy) && r.resolvedBy === data.labeler) {
        warnings.push(
          `${p.id}: resolved by the same person who labeled it; a second person is preferred`
        );
      }
    }
    if (c && e) {
      const rule = isSeedVariantByRule(c, e);
      if (rule && finalLabel(p) !== 'seed_variant')
        warnings.push(`${p.id}: matches the seed-copy code rule but is labeled ${finalLabel(p)}`);
      if (!rule && finalLabel(p) === 'seed_variant')
        warnings.push(`${p.id}: labeled seed_variant but does not match the seed-copy code rule`);
    }
  }

  const candidates = [...byId.values()].filter((q) => q.role === 'candidate');
  const counts = Object.fromEntries(
    FINAL_LABELS.map((l) => [l, (data.pairs ?? []).filter((p) => finalLabel(p) === l).length])
  );
  if (minimums) {
    if (candidates.length < minimums.candidates)
      errors.push(
        `need at least ${minimums.candidates} candidate questions, have ${candidates.length}`
      );
    for (const l of ['duplicate_question', 'answer_leakage', 'related_distinct']) {
      if (counts[l] < minimums[l])
        errors.push(`need at least ${minimums[l]} ${l} pairs (final labels), have ${counts[l]}`);
    }
  }
  return { errors, warnings, counts, candidates: candidates.length };
}

/** Deterministic top-K shortlist of the pool for each candidate. Uses only question text. */
export function shortlistFor(data, k = SHORTLIST_K) {
  const pool = data.questions.filter((q) => q.role === 'pool');
  return data.questions
    .filter((q) => q.role === 'candidate')
    .map((cand) => {
      const prepared = new Map([...pool, cand].map((q) => [q.id, prepare(q)]));
      const guards = buildAnswerGuards(prepared);
      const top = rankPool(cand.id, prepared, { leak: true, guards }).slice(0, k);
      return { candidate: cand.id, top };
    });
}

export function shortlistPairs(data, k = SHORTLIST_K) {
  return shortlistFor(data, k).flatMap((s) =>
    s.top.map((t) => ({ candidate: s.candidate, existing: t.id, score: t.score }))
  );
}

export function unlabeledShortlisted(data, k = SHORTLIST_K) {
  const labeled = new Set(data.pairs.map((p) => pairKey(p.candidate, p.existing)));
  return shortlistPairs(data, k).filter((p) => !labeled.has(pairKey(p.candidate, p.existing)));
}

/** Everything that must hold before the labels may be frozen and scored. */
export function checkReadyToFreeze(data, opts) {
  const v = validateLabels(data, opts);
  const errors = [...v.errors];
  const missing = unlabeledShortlisted(data);
  if (missing.length > 0)
    errors.push(
      `${missing.length} shortlisted pair(s) are not labeled yet; run "shortlist" for the list`
    );
  return { ...v, errors, missing };
}

export function verifyFrozen(dir, opts) {
  const labelsPath = join(dir, 'labels.json');
  const freezePath = join(dir, 'freeze.json');
  if (!existsSync(labelsPath) || !existsSync(freezePath))
    return {
      ok: false,
      reason: 'labels.json and freeze.json are both required; run "freeze" first',
    };
  const text = readFileSync(labelsPath, 'utf8');
  const freeze = JSON.parse(readFileSync(freezePath, 'utf8'));
  if (sha256(text) !== freeze.sha256)
    return { ok: false, reason: 'labels.json changed after it was frozen' };
  const data = JSON.parse(text);
  const ready = checkReadyToFreeze(data, opts);
  if (ready.errors.length > 0)
    return { ok: false, reason: `labels no longer pass validation: ${ready.errors[0]}` };
  return { ok: true, data, freeze };
}

/**
 * Result rows that cannot be trusted as post-freeze: recorded before the freeze, or with a
 * missing or unparseable timestamp (so their timing cannot be shown to follow the freeze).
 */
export function findResultsBeforeFreeze(rows, freeze) {
  const frozenAt = Date.parse(freeze.frozenAt);
  if (Number.isNaN(frozenAt)) throw new Error('freeze.json has no valid frozenAt timestamp');
  return rows.filter((r) => {
    const t = Date.parse(r.requestedAt);
    return Number.isNaN(t) || t < frozenAt;
  });
}

/** Locks labels.json by hash. Refuses if the labels are not ready or scoring has already started. */
export function freezeLabels(dir, opts) {
  const text = readFileSync(join(dir, 'labels.json'), 'utf8');
  const data = JSON.parse(text);
  const r = checkReadyToFreeze(data, opts);
  if (existsSync(join(dir, 'results', 'raw-judgments.jsonl'))) {
    r.errors.push(
      'results already exist for this set; labels cannot be frozen after scoring has started'
    );
  }
  if (r.errors.length === 0) {
    writeFileSync(
      join(dir, 'freeze.json'),
      JSON.stringify(
        {
          sha256: sha256(text),
          frozenAt: new Date().toISOString(),
          labeler: data.labeler,
          shortlistK: SHORTLIST_K,
          candidates: r.candidates,
          finalLabelCounts: r.counts,
        },
        null,
        2
      ) + '\n'
    );
  }
  return r;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const dir = rest.includes('--dir') ? rest[rest.indexOf('--dir') + 1] : join(HERE, 'independent');
  const labelsPath = join(dir, 'labels.json');
  if (!['validate', 'shortlist', 'freeze'].includes(cmd)) {
    console.error('usage: independent-set.mjs <validate|shortlist|freeze> [--dir DIR]');
    process.exit(2);
  }
  if (!existsSync(labelsPath)) {
    console.error(
      `${labelsPath} not found. A human labeler creates it from independent/template.json.`
    );
    process.exit(2);
  }
  const text = readFileSync(labelsPath, 'utf8');
  const data = JSON.parse(text);
  const report = (r) => {
    for (const w of r.warnings) console.log(`warning: ${w}`);
    for (const e of r.errors) console.error(`error: ${e}`);
  };

  if (cmd === 'validate') {
    const r = validateLabels(data);
    report(r);
    console.log(`candidates ${r.candidates}; final labels ${JSON.stringify(r.counts)}`);
    process.exit(r.errors.length ? 2 : 0);
  }
  if (cmd === 'shortlist') {
    const r = validateLabels(data, { minimums: null });
    report(r);
    if (r.errors.length) process.exit(2);
    const list = shortlistFor(data);
    const missing = unlabeledShortlisted(data);
    const byId = new Map(data.questions.map((q) => [q.id, q]));
    writeFileSync(join(dir, 'shortlist.json'), JSON.stringify(list, null, 2) + '\n');
    writeFileSync(
      join(dir, 'to-label.json'),
      JSON.stringify(
        missing.map((m) => ({
          candidate: m.candidate,
          existing: m.existing,
          candidateText: byId.get(m.candidate).question,
          existingText: byId.get(m.existing).question,
          label: '',
        })),
        null,
        2
      ) + '\n'
    );
    console.log(
      `shortlist K=${SHORTLIST_K}: ${list.length} candidates, ${shortlistPairs(data).length} pairs, ${missing.length} still unlabeled (see to-label.json)`
    );
    process.exit(0);
  }
  const r = freezeLabels(dir);
  report(r);
  if (r.errors.length) process.exit(2);
  console.log(
    'frozen: labels are now locked. Commit labels.json and freeze.json before running flow.mjs.'
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
