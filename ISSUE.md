# Feature request: a goal-based "Target" system for practice

## Summary

I'd love CPOS to have a **targeted practice mode**: I pick a rating I want to reach
(say Expert / 1600), and CPOS tells me **where I stand, which topics I still need to
cover to get there, and the order I should practise them in.** Right now I can see
what to solve *next*, but not what to solve to hit a *specific goal*.

## Why — the motivation

I've been using the **Recommend** tab a lot and it's genuinely good. It reads my
history, finds a sensible stretch level, and surfaces solid problems. No complaints
there.

But the way I actually think about improving is goal-shaped. I don't think "give me a
good next problem" — I think *"I'm a Specialist, I want to be an Expert, so what's
standing between me and 1600?"* That's a different question, and the current
recommender can't really answer it:

- It always aims at a moving stretch (~300 above wherever I am). I can't point it at
  **1600** and have it plan backwards from there.
- It can't tell me **which topics I'm missing** for that rating. If I've never
  touched, say, DSU or bitmasks, nothing flags that as a gap — an untouched topic
  basically reads as "fine."
- It gives me a flat list, not a **path**. There's no "do these foundations first,
  then these, then you're ready for the target band."

So the thing I keep wishing for is a screen where I set a goal and get a clear,
honest answer: *here's your gap, here are the topics still in your way, here's the
order to close them.*

## What I'm proposing

A dedicated **Target** area where:

1. I **set a goal rating** — either by stepping through Codeforces rank milestones
   (Pupil 1200, Specialist 1400, Expert 1600, CM 1900, Master 2100…) or by typing an
   exact number.
2. CPOS shows my **current standing**: my effective level, the gap to the goal, and
   an overall "readiness" for that target.
3. CPOS lists the **topics I still need to cover** for that rating, each marked as
   something like *Ready / Developing / Gap / Untouched*, weakest first.
4. CPOS gives me an **ordered, step-by-step plan** of problems that ramps from my
   level up to the goal, putting my weak/uncovered topics first.

## Why this would help — the plus points

**1. It turns practice into a directed journey.** A concrete rating goal is far more
motivating than "here's another problem." I can see the finish line and aim at it.

**2. It makes my blind spots visible.** The biggest value: being told *"for 1600 you
still haven't touched graphs and DSU."* You can't fix a gap you can't see, and a
plain recommender hides untouched topics because there's no failure data on them.

**3. It respects the rating band, not just the topic.** Being okay at DP at 1200 is
not the same as being okay at DP at 1600. A target-aware view can say "you've solved
DP, but only easy DP — that's a gap for this goal," which is exactly the nuance that
decides whether you actually rank up.

**4. It removes decision fatigue with an order.** Instead of staring at a flat list
and guessing, I get a sequence: foundations first, then build, then push into the
target band. I just work top to bottom.

**5. It tells me what NOT to waste time on.** If a topic is already solid for the
goal, it drops down the list. If a topic doesn't matter until a much higher rating, it
isn't pushed on me yet. Time goes to the things that actually move the needle for
*this* goal.

**6. It gives a measurable sense of progress.** A readiness % and a shrinking gap
number are something I can watch move as I grind — a much better feedback loop than a
list that just refreshes.

**7. It complements the existing Recommend tab rather than replacing it.** Recommend
stays great for "I have 30 minutes, give me something good." Target answers "I have a
season, get me to Expert." Different jobs, both useful.

## Scope

- Codeforces-focused, since CSES tasks don't carry a rating — targeting only makes
  sense where there's a rating ladder.
- Should reuse the existing TUI look and key conventions (panels, theme, `j`/`k`,
  `enter`/`o`) so it feels native, not bolted on.
- Bonus: the same goal-awareness could also make the regular Recommend tab smarter
  about coverage gaps.

## Acceptance criteria

- [ ] A way to set a target rating (milestones + custom value).
- [ ] A current-status read: effective level, gap, overall readiness.
- [ ] A per-topic breakdown of what's still needed for the goal.
- [ ] An ordered problem plan that ramps toward the goal, weak areas first.
- [ ] Starting a planned problem flows into the normal solve workflow.

I'm happy to implement this — opening a PR alongside this issue.
