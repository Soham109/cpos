# Targeted recommendations (Target tab)

This document covers the recommendation-system analysis behind the new **Target**
tab and how the feature works. It is Codeforces-focused, since CSES tasks carry no
rating.

## Analysis of the previous recommender

The original engine lives in `src/engine/recommender.rs` and is still used by the
**Recommend** tab. It works in two regimes — *cold start* (no history → popular
mid-tier classics) and *warm* (infer a practice level from solved/attempted rating
percentiles, then score candidates by rating-fit + log-popularity + weak-topic
weight, and diversify by tag/rating).

It is solid for "what should I grind next?", but three things limit it as a way to
reach a chosen rating:

| Limitation | Why it matters |
| --- | --- |
| **The target is implicit.** It always aims roughly `level + 300`; you can't say "take me to 1600." | No goal means no plan and no sense of distance to the goal. |
| **Weakness is rating-blind and coverage-blind.** Weakness is a single global per-tag solve rate, and a topic you've *never touched* scores as if mastered (weight 0). | "dp" is treated the same at 1200 and 1600, and genuine prerequisite blind spots are invisible. |
| **The output is a flat ranked list**, not an ordered ramp. | Nothing walks you from your level up to the goal, weakest fundamentals first. |

## What changed

Two pieces, per the limitations above.

**1. New `Target` tab + engine (`src/engine/target.rs`).** Pick a goal rating
(cycle CF rank milestones with `[`/`]`, or press `t` to type an exact number) and
get: a current-status read (effective level, gap, overall readiness %), a
**Topics to Cover** table, and a **step-by-step plan** of problems.

**2. Smarter existing recommender.** Gated on having history so cold-start behavior
is unchanged, the Recommend engine now treats **core prerequisite topics you've
never solved as coverage gaps** (instead of mastered), and nudges weak topics
you've only ever cleared **well below your target band**. Untouched core topics now
surface with a "New topic to cover" reason.

## How the Target engine works

**Curriculum.** A table maps each Codeforces topic to the rating at which it
typically becomes essential (e.g. binary search ~1300, dp ~1500, graphs/dsu ~1600,
data structures ~1700, flows ~2300). For a chosen target we keep the topics that
matter at or below that band.

**Readiness.** For each in-scope topic we look at what you've solved in it and label
it `Ready` / `Developing` / `Gap` / `Untouched`. Topics whose essential band sits
near the goal weigh most. The overall readiness % is the relevance-weighted share
of topics that are ready; the focus list is everything not yet `Ready`, most
important first.

**Step-by-step plan.** We build rating rungs from a little below your level up to the
goal in 100-point steps (at most the five rungs nearest the target). Each rung is
filled with unsolved Codeforces problems, scored so your weakest in-scope topics come
first, capped per topic so a rung stays varied. Concatenated low→high, the result is
a ramp that hammers weak areas while climbing toward the target. Each step is labelled
`Base` / `Build` / `Push` / `Target`, and `(focus)` when it hits a focus topic.

Pressing `enter`/`o` on a step starts it in the normal Problems workflow (scaffold,
open statement, run/submit), exactly like the Recommend tab.

## Files touched

| File | Change |
| --- | --- |
| `src/engine/target.rs` | New — curriculum, readiness, plan, milestones (+ unit tests). |
| `src/engine/recommender.rs` | Coverage + band-gap signal (history-gated); new test. |
| `src/ui/target.rs` | New — Target tab view (goal header, topics table, plan list). |
| `src/app.rs` | `Tab::Target`, state, `compute_target_plan` + goal/scroll/start methods. |
| `src/main.rs` | Input routing: navigation, `[`/`]` goal cycle, `t` custom entry, start step. |
| `src/engine/mod.rs`, `src/ui/mod.rs` | Register the new modules. |

## Keys (Target tab)

`j`/`k` move · `enter`/`o` open & solve · `[` / `]` change goal milestone ·
`t` type an exact goal · `r` sync (global) · `Tab` switch tabs (global).
