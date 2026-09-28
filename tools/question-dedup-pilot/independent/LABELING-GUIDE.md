# Independent labeling guide

You are labeling question pairs for the duplicate-detection pilot. **You must not be the person who
built the pilot, and you must not look at any TypeSafe output** (no results files, reports or API
responses) until the labels are frozen. The whole point is a fair test: your labels are the ground truth.

Nothing here touches live games, the question bank in the database, competitions or money. It is a
JSON file and some offline scripts.

## What you write

Copy `template.json` to `labels.json` in this folder and replace the examples (entries marked
`"example": true` are rejected).

- **`labeler`**: your name. Set `attestation.blindToTypeSafe` to `true` only if it is true.
- **`questions`**: a `pool` of existing questions (the "bank") and `candidate` questions (new ones
  someone is about to add). Make them realistic: the wording and mistakes real question writers make,
  not tidy textbook paraphrases. Vary topic, difficulty, phrasing and choice order.
- **`pairs`**: one row per (`candidate`, `existing`) relation, with a `label` from the list below.

Minimums before the set can be frozen: 30 candidates, and by final label at least 12
`duplicate_question`, 12 `answer_leakage` and 20 `related_distinct`. Write real **hard negatives**: pairs
that share a topic, numbers, wording or a template but ask for different facts (`12 x 11` vs `12 x 12`,
`east of Africa` vs `west of Africa`). They are the most informative part of the set.

## Labels

| Label                | Use it when                                                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `duplicate_question` | The same fact is asked with the same correct answer, reworded. One makes the other redundant.                                                                                                                                |
| `answer_leakage`     | It is a different question, but its wording or correct answer gives away the other's answer (the answer appears in the other's text, the questions are inverses of each other, or two closely linked facts share an answer). |
| `related_distinct`   | Same topic or template, different fact and different answer. A hard negative.                                                                                                                                                |
| `unrelated`          | Nothing meaningful in common.                                                                                                                                                                                                |
| `seed_variant`       | An intentional `(set N)` copy of a seeded question. Rare; the code detects these.                                                                                                                                            |

**Tie-breakers for duplicate versus leakage** (apply in order):

1. Same fact **and** same correct answer, only wording differs: `duplicate_question`.
2. The two are inverses (asking for A given B, and B given A): `answer_leakage`.
3. The correct answer of one appears in the text of the other: `answer_leakage`.
4. Same answer reached through a different fact: `answer_leakage`.
5. Different fact and different answer, only topic or template shared: `related_distinct`.

If two rules point at different labels, or you honestly cannot decide, mark the pair
`"ambiguous": true` and do not guess. Ambiguous pairs must be **resolved before scoring**:

```json
"ambiguous": true,
"resolution": { "label": "answer_leakage", "resolvedBy": "second person's name", "rationale": "why" }
```

Prefer a second person for the resolution. If it is the same person, the tools warn.

## Steps

Run these from the repository root. None of them call TypeSafe.

```sh
node tools/question-dedup-pilot/independent-set.mjs validate     # structure and minimums
node tools/question-dedup-pilot/independent-set.mjs shortlist    # writes shortlist.json and to-label.json
```

`shortlist` uses only question text (no TypeSafe output). It lists the pool questions the system would
show TypeSafe for each candidate (top 5). **Label every pair listed in `to-label.json`** by adding it to
`pairs`, using `unrelated` where nothing relates. Repeat until `shortlist` reports 0 unlabeled, then:

```sh
node tools/question-dedup-pilot/independent-set.mjs freeze
```

`freeze` checks everything, records a hash of `labels.json` in `freeze.json`, and locks the labels.
Commit both files. The flow runner will not call the API unless the hash still matches, so labels cannot
be changed after seeing results without it being visible.
