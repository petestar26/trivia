# TypeSafe pilot report (offline, labeled pairs only)

Model: jev-1.13.0 (requested alias `jev-latest`). Pairs judged: 88/88. Failed requests: 0.
Fixed thresholds (declared before any call, not tuned on any split): flag at >= 0.9, review at >= 0.4, duplicate also needs same_answer >= 0.8.
Verdict priority: seed copy by code rule > duplicate > leakage > review > distinct.

## Cost and latency

- Input tokens (billable): 58823 total, mean 668, median 668, p95 682 per request.
- Output tokens (free per the API spec): 4928 total, mean 56 per request.
- The API reports token counts only; no dollar price is available from it, so none is stated.
- Latency per request: median 242 ms, p95 448 ms, max 590 ms.
- Stage `sample`: 12/12 ok, 3250 ms wall time, concurrency 1.
- Stage `expand`: 76/76 ok, 5097 ms wall time, concurrency 4.

## dev (post-hoc: the shortlist rule was motivated by dev pairs; not independent validation)

| label | pairs | duplicate | leakage | review | distinct | seed copy (code rule) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| duplicate_question | 20 | 19 | 1 | 0 | 0 | 0 |
| answer_leakage | 16 | 2 | 6 | 8 | 0 | 0 |
| related_distinct | 25 | 0 | 0 | 3 | 22 | 0 |
| seed_variant | 12 | 0 | 0 | 0 | 0 | 12 |

- **Duplicates:** flagged as duplicate 19/20; flagged only as leakage 1; sent to review 0; **missed** 0/20.
- **Answer leakage:** flagged as leakage 6/16; flagged as duplicate 2; sent to review 8; **missed** 0/16.
- **related_distinct false positives:** 0/25 flagged (duplicate 0, leakage 0); a further 3 sent to review; 22 correctly distinct.
- **Seed variants:** 12/12 classed as seed copies by the code rule; the model alone would have called 12/12 duplicates.

Median [min-max] probability by label:

| label | same_fact | same_answer | leakage |
| --- | --- | --- | --- |
| duplicate_question | 0.99 [0.81-0.99] | 0.99 [0.99-0.99] | 0.94 [0.92-0.95] |
| answer_leakage | 0.15 [0.05-0.95] | 0.99 [0.04-0.99] | 0.91 [0.54-0.94] |
| related_distinct | 0.02 [0.01-0.04] | 0.02 [0.02-0.98] | 0.08 [0.03-0.80] |
| seed_variant | 0.99 [0.98-0.99] | 0.99 [0.99-0.99] | 0.94 [0.93-0.96] |

Pairs to inspect:

- p013 missed/uncertain duplicate (verdict leakage; fact 0.81, answer 0.99, leakage 0.94): "Which number multiplied by itself gives 81?" vs "What is the square root of 81?"
- p021 missed/uncertain leakage (verdict review; fact 0.40, answer 0.99, leakage 0.88): "The Eiffel Tower stands in which European capital city?" vs "What is the capital of France?"
- p024 missed/uncertain leakage (verdict review; fact 0.07, answer 0.99, leakage 0.65): "In which ocean is the Mariana Trench located?" vs "What is the largest ocean on Earth?"
- p025 missed/uncertain leakage (verdict review; fact 0.20, answer 0.99, leakage 0.89): "Which element has the chemical symbol Hg?" vs "Which metal is liquid at room temperature?"
- p026 missed/uncertain leakage (verdict review; fact 0.06, answer 0.98, leakage 0.69): "A regular hexagon can be divided into how many equilateral triangles?" vs "How many sides does a hexagon have?"
- p029 missed/uncertain leakage (verdict review; fact 0.14, answer 0.99, leakage 0.84): "Which gas, released by burning fossil fuels, is a major greenhouse gas?" vs "Which gas do plants absorb from the air?"
- p031 missed/uncertain leakage (verdict review; fact 0.11, answer 0.98, leakage 0.82): "Which African river flows north through Egypt to the Mediterranean?" vs "Which is the longest river in the world?"
- p033 missed/uncertain leakage (verdict review; fact 0.05, answer 0.04, leakage 0.82): "On a soccer pitch, how many outfield players does each team have, excluding the goalkeeper?" vs "How many players are on a soccer team on the field?"
- p034 missed/uncertain leakage (verdict review; fact 0.06, answer 0.99, leakage 0.54): "What is 10% of 300?" vs "What is 15% of 200?"
- p049 related_distinct sent to review (verdict review; fact 0.04, answer 0.98, leakage 0.80): "How many seconds are in one minute?" vs "How many minutes are in one hour?"
- p052 related_distinct sent to review (verdict review; fact 0.03, answer 0.02, leakage 0.52): "How many days are in a normal, non-leap year?" vs "How many days are in a leap year?"
- p060 related_distinct sent to review (verdict review; fact 0.02, answer 0.02, leakage 0.44): "Which ocean lies west of Africa?" vs "Which ocean lies east of Africa?"

## holdout (written after the shortlist rule was fixed; same author, 3-4 pairs per label: weak evidence)

| label | pairs | duplicate | leakage | review | distinct | seed copy (code rule) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| duplicate_question | 4 | 4 | 0 | 0 | 0 | 0 |
| answer_leakage | 4 | 0 | 2 | 2 | 0 | 0 |
| related_distinct | 4 | 0 | 0 | 1 | 3 | 0 |
| seed_variant | 3 | 0 | 0 | 0 | 0 | 3 |

- **Duplicates:** flagged as duplicate 4/4; flagged only as leakage 0; sent to review 0; **missed** 0/4.
- **Answer leakage:** flagged as leakage 2/4; flagged as duplicate 0; sent to review 2; **missed** 0/4.
- **related_distinct false positives:** 0/4 flagged (duplicate 0, leakage 0); a further 1 sent to review; 3 correctly distinct.
- **Seed variants:** 3/3 classed as seed copies by the code rule; the model alone would have called 3/3 duplicates.

Median [min-max] probability by label:

| label | same_fact | same_answer | leakage |
| --- | --- | --- | --- |
| duplicate_question | 0.99 [0.98-0.99] | 0.99 [0.99-0.99] | 0.94 [0.92-0.94] |
| answer_leakage | 0.07 [0.06-0.40] | 0.21 [0.05-0.99] | 0.85 [0.72-0.94] |
| related_distinct | 0.01 [0.01-0.06] | 0.02 [0.02-0.99] | 0.11 [0.04-0.78] |
| seed_variant | 0.98 [0.90-0.99] | 0.99 [0.98-0.99] | 0.94 [0.93-0.96] |

Pairs to inspect:

- p078 missed/uncertain leakage (verdict review; fact 0.06, answer 0.05, leakage 0.72): "Neil Armstrong's famous 'one small step' came during which event?" vs "Who was the first person to walk on the Moon?"
- p079 missed/uncertain leakage (verdict review; fact 0.09, answer 0.99, leakage 0.81): "In which country would you find the city of Rio de Janeiro?" vs "Which country hosted the 2016 Summer Olympics?"
- p082 related_distinct sent to review (verdict review; fact 0.06, answer 0.99, leakage 0.78): "How many legs does a spider have?" vs "How many sides does an octagon have?"

## Caveats

- Thresholds and question wording were fixed in advance and not tuned on either split; no threshold sweep was run. Nothing here selects a production threshold.
- Labels and pairs were written by one author and the dev split is post-hoc, so these numbers are a smoke test. Independent examples are needed before any app integration.
- Unlabeled pool pairs were not judged, so precision on real traffic is unmeasured.
- The alias `jev-latest` can move to a new model version; each raw row records the resolved model.
