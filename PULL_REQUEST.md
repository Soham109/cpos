# Add a goal-based "Target" practice system (+ smarter Recommend)

Closes #<!-- issue number -->.

## Why I did this

I love the **Recommend** tab — it reads my history, picks a sensible stretch level,
and surfaces good problems. It's genuinely useful and I didn't want to change how it
feels.

But the way I actually think about getting better is goal-shaped. I don't ask "what's
a good next problem?" — I ask *"I'm a Specialist, I want Expert, so what's between me
and 1600?"* The current recommender can't answer that: it always aims at a moving
target ~300 above wherever I am, it can't tell me which **topics I still haven't
covered** for a specific rating, and it gives me a flat list instead of a **path**.

So I built the thing I kept wishing for: I set a goal rating and CPOS tells me where I
stand, **which topics are still left to reach that rating**, and the **order** to
practise them in. Being able to literally see "for 1600 you still haven't touched
graphs/DSU, and your DP is only easy-DP" is the part that I think makes practice
actually targeted instead of just busy.

## Why it helps (the value)

- **Directed practice toward a concrete goal**, not just "next problem."
- **Blind spots become visible** — untouched prerequisite topics are surfaced instead
  of silently treated as "fine."
- **Rating-band aware** — "DP at 1200" ≠ "DP at 1600"; a topic solved only at easy
  ratings is flagged as a gap for the goal.
- **An order, not a pile** — a ramp from your level to the target, weakest/uncovered
  topics first, so there's no decision fatigue.
- **Focuses time** — mastered or not-yet-relevant topics drop down the list.
- **Measurable progress** — a readiness % and a shrinking gap to watch.
- **Complements Recommend** — Recommend = "give me something good now"; Target = "get
  me to Expert."

## What this PR does

### New: Target tab + engine

A dedicated **Target** tab (sits between Recommend and Config, same theme and key
conventions). You set a goal and get three things:

- **Goal + status header** — pick the goal by cycling Codeforces rank milestones
  (`[` / `]`) or typing an exact rating (`t`). Shows your effective level, the gap to
  the goal, an overall **readiness %**, and how many problems you've solved in the
  goal band.
- **Topics to Cover** — every prerequisite topic for the goal, each labelled
  **Ready / Developing / Gap / Untouched**, sorted by priority (weakest and most
  goal-relevant first), with the rating the topic matters at and your best solve.
- **Step-by-step plan** — unsolved Codeforces problems laid out on rating rungs from
  your level up to the goal, weak/uncovered topics front-loaded, each step labelled
  **Base → Build → Push → Target** (and `(focus)` when it hits a focus topic).
  `enter`/`o` starts a step in the normal solve workflow (scaffold, open statement,
  run/submit), exactly like Recommend.

How the engine works (`src/engine/target.rs`):

- A **curriculum** maps each CF topic to the rating it becomes essential at
  (binary search ~1300, DP ~1500, graphs/DSU ~1600, data structures ~1700,
  flows ~2300, …). For a goal we keep the topics that matter at or below that band.
- **Readiness** per topic is derived from what you've solved in it, weighted by how
  close the topic's band is to the goal; the overall readiness % is the
  relevance-weighted share of topics that are ready.
- The **plan** builds 100-point rating rungs from a little below your level up to the
  goal (at most the five nearest the target), fills each rung with the highest-priority
  unsolved problems, caps per-topic so a rung stays varied, and concatenates low→high
  into a ramp (capped at 32 steps).

### Improved: the existing Recommend engine

Per the issue's "bonus," the regular recommender is now coverage- and band-aware too,
**gated on having history so cold-start behaviour is unchanged**:

- Core prerequisite topics you've **never solved** are treated as **coverage gaps**
  instead of as mastered (the old scoring gave untouched topics zero weight, which hid
  them). These surface with a "New topic to cover" reason.
- Topics you've only ever cleared **well below your target band** get a small nudge.
- The reason text now ignores already-mastered tags so it doesn't mislabel them as
  "weak."

### Wiring & UX

- `Tab::Target` added to the tab bar, state, and all match sites.
- Goal auto-defaults to the next rank milestone above your rating until you pick one.
- The plan recomputes on initial load, after a Codeforces sync, and after a CSES
  progress sync.
- Keys: `j`/`k` move · `enter`/`o` open & solve · `[` / `]` change goal milestone ·
  `t` type an exact goal · `r` sync · `Tab` switch tabs.

## Files changed

| File | Change |
| --- | --- |
| `src/engine/target.rs` | **New** — curriculum, readiness model, plan builder, CF milestones, helpers, unit tests. |
| `src/ui/target.rs` | **New** — Target tab view (goal header, topics table, plan list). |
| `src/engine/recommender.rs` | Coverage + band-gap signal (history-gated); reason cleanup; new test. |
| `src/app.rs` | `Tab::Target`, state fields, `compute_target_plan` + goal/scroll/start methods, auto-default goal, recompute hooks. |
| `src/main.rs` | Input routing — navigation, `[`/`]` cycle, `t` custom entry, start-step; custom-entry field. |
| `src/engine/mod.rs`, `src/ui/mod.rs` | Register the new modules. |
| `docs/targeted-recommendations.md` | **New** — analysis + design notes. |

## Tests

- New unit tests in `src/engine/target.rs`: rank-name mapping, milestone cycling,
  untouched prerequisite flagged as a focus topic, the plan ramps upward and reaches
  the target band, solved problems are never recommended, readiness stays in bounds.
- New test in `src/engine/recommender.rs`: an untouched core topic is surfaced ahead
  of an already-known one. **Existing recommender tests are unchanged and still pass**
  (the new signal is gated on history, so cold-start behaviour is identical).

```bash
cargo test            # all tests
cargo test target     # just the new engine
cargo test recommend  # the recommender, incl. the coverage test
```

## How to try it

```bash
rustup update stable   # needs Rust >= 1.85 (edition 2024)
cargo run
```

Set your Codeforces handle (setup wizard on first run, or the **Config** tab), press
`r` to sync, then `Tab` to **Target**. Pick a goal with `[` / `]` or `t`, review the
topics and the plan, and press `enter` on a step to start solving.

## Notes / design choices

- **Codeforces-focused** — CSES tasks have no rating, so they're excluded from the
  plan; the readiness model keys off CF tags + ratings.
- **Additive and low-risk** — the Target engine is a separate module, and the
  Recommend change is gated so it can't alter cold-start output.
- Reuses the existing theme, panels, progress bars, and key conventions so it feels
  native.

## Demo video

<!-- Paste your walkthrough link/embed here. Suggested flow to record:
     1. Open the Target tab.
     2. Cycle the goal with [ ] and type a custom one with t.
     3. Show the readiness %, the Topics to Cover table, and the step-by-step plan.
     4. Press enter on a step to start solving it.
     5. (Optional) Show the Recommend tab now surfacing a "New topic to cover".
-->

_(video coming — placeholder)_

## Checklist

- [ ] `cargo build` / `cargo test` pass locally
- [ ] Manually verified the Target tab after a real sync
- [ ] Screenshots/video attached
- [ ] Linked to the issue above
