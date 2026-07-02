# Hyperwire — Orchestration Model & VCS Decisions

> Continues `02-omp-ui-correction-and-direction.md`. Records the owner's VCS decision
> (S3, jj-native), the orchestration-model rundown given to the owner (decision pending
> their read; instinct = fluid/dynamic, aligning with Option C), and the concurrency-
> literature research direction. Also: `omp-ui` was merged up to v16.3.0
> (commit 08b14429a) — `bun check` clean, 185/185 scoped tests pass.

## 1. Orchestration model — the three options (rundown)

**Option A — Declarative DAG patterns** (Plan 1 Phase 1). Orchestration authored as a
static artifact: nodes + `needs` edges + Handlebars prompts referencing upstream
outputs; a generic scheduler executes it. Wins: the strategy is a validated,
renderable, diffable, forkable *object*; agents author strategies as data.
Losses: it is a program in disguise — "retry until tests pass," "one worker per
failing file" force loops/conditionals into the spec (language creep, contra P7);
static shape fights emergent mission structure; competes with the eval kernel.

**Option B — Code-as-orchestration** (ships today). Orchestrator agents write JS/Python
in the persistent eval kernel calling `agent()`/`parallel()`/`pipeline()`, or use the
task tool directly. Wins: full expressiveness, zero new machinery, LLMs are good at
code. Losses: the strategy is opaque as an artifact; no pre-run validation; comparison
= reading code; observability only as good as what the spawn path records.

**Option C — Split the concerns (recommended).**
- *Composition & policy = data*: **crew templates** — discovered files
  (`.omp/crews/*.json5`) declaring cast (agent types, counts, briefs), policy envelope
  (budgets, write roots, spawn rights, escalation), and a topology *hint* for cockpit
  layout (not a scheduler). Fluid: the template is the mission's starting shape; the
  forest then evolves by agent judgment.
- *Control flow = code (or judgment)*: most missions need no scripted control flow at
  all — the orchestrator LLM decides dynamically; when scripting is wanted, the eval
  kernel is the substrate. No DAG language.
- *Record = data*: the **universal spawn journal** — every spawn from any path (task,
  eval, swarm, cockpit) writes one uniform row (runId, nodeId, parentId, agentType,
  definitionHash, promptHash, model, tokens, cost, outcome, sessionFile). The cockpit
  renders the live forest + history from it; replay/fork/compare attach to it.
- Option A remains addable later as one more journal-emitting frontend if an
  experiment-bench need materializes.

Owner's stated instinct: "fluid, flexible, dynamic agent configurations, not static" —
consistent with C. (Final confirmation pending owner's read of this rundown.)

## 2. VCS decision: S3 — jj-native (owner, 2026-07-02)

Priorities: (b) shared-visibility concurrency first, (a) provenance/undo second — both
required. Owner chose S3 as "the correct and elegant way"; pursue it.

### Why jj maps almost one-to-one onto the multi-agent problem

- **Working-copy-as-commit + auto-snapshot** → commit-per-edit *for free*; no hook
  choreography, no shadow refs. Every agent edit becomes a recorded change.
- **Workspaces** (multiple working copies sharing one repo store, each with its own
  `@`) → one workspace per agent: cheap isolation with **live mutual visibility** —
  agents (and the cockpit) can read each other's in-progress changes through the repo
  without merging. This is (b): concurrency with sight, not blindness.
- **Op log** → every repo mutation recorded and undoable: forest-wide undo, "what did
  agent X do at 14:32," mission-level rollback. This is (a) natively.
- **First-class conflicts** → merges never block; conflicts are recorded objects routed
  to the cockpit (or a resolver agent) as attention items, resolved when convenient.
- **evolog / change identity** → a change's evolution over an agent's retries is
  itself inspectable history.

### Build sketch (to be step-decomposed)

1. `utils/jj.ts` grows a mutating surface: `workspace add/forget`, `new`, `describe`,
   `squash`, `rebase`, `op log`/`op undo` reads, snapshot trigger (any jj command
   snapshots; a cheap `jj st` after write-tool results suffices initially).
2. **Colocated-git first** (`.jj` alongside `.git`): keeps git interop for remotes,
   upstream tooling, and omp's git-first internals; pure-jj support later if wanted.
3. New executor isolation mode `jj-workspace` alongside the pi-iso backends: spawn =
   `workspace add`, integrate = rebase/squash onto the mission change, abandon =
   `workspace forget` + `abandon`.
4. Journal links `nodeId ↔ changeId/opId`; cockpit gets op-log and per-agent change
   views; conflict objects become attention items.
5. Fallback ladder preserved: repos without jj (or Windows edge cases) fall back to
   pi-iso CoW isolation — jj-native is a mode, not a hard requirement.

### Risks (accepted, tracked)

jj maturity/velocity (pin a version; wrap CLI not internals); colocated-mode quirks
with tools that mutate `.git` directly; many-workspace performance on huge repos
(store is shared — expected fine); upstream omp explicitly rejects pure-jj today
(colocated is within bounds); divergence cost if upstream's VCS layer moves.

## 3. Research direction: concurrency literature → agent swarms

Owner directive: mine classical concurrency/distributed-systems theory for strategies
novel in harness-land. Initial candidate map (each = mechanism → agent-swarm
translation):

1. **MVCC / snapshot isolation** → agents read consistent snapshots, writers don't
   block readers — jj workspaces give this natively; formalize "read snapshot" per
   task assignment.
2. **Optimistic concurrency control / STM** → agents work speculatively, *validate at
   integration* (did anything I read change under me?), retry-or-rebase on conflict —
   maps to jj rebase + re-run-node-with-fresh-context.
3. **Conflict serializability** → observe each agent's file **read/write sets** (from
   tool calls — we see every read/edit), build the conflict graph; acyclic ⇒ a clean
   integration order exists (topo-sort the merges); cycles ⇒ route to resolution.
   Genuinely novel in harness-land and cheaply implementable.
4. **Hierarchical intention locks** (databases) → coarse path-tree locks: an agent
   takes IX on `src/parser/` instead of 40 file locks; cockpit shows the lock tree.
5. **Erlang/OTP supervision trees** → crews get restart strategies
   (one_for_one, rest_for_one, escalate-after-N) instead of ad-hoc failure handling;
   "let it crash" + supervisor policy as crew-template fields.
6. **Sagas / compensating transactions** → long missions as sagas; each step records a
   compensation (jj op undo / abandon); mission abort = run compensations in reverse.
7. **Work stealing** (Cilk/Tokio) → idle agents steal queued subtasks from overloaded
   orchestrators' decks; global budget semaphore becomes a scheduler, not just a cap.
8. **Deadlock detection via wait-for graphs** → agents wait on locks *and* IRC replies;
   cockpit maintains the unified wait-for graph, detects cycles, surfaces them as
   attention items (auto-break by policy: youngest waiter aborts/rebases).
9. **Priority inheritance** → an agent holding a resource a high-priority mission needs
   inherits its priority (model tier / budget boost) until release.
10. **Vector clocks / happened-before** → causal ordering across the journal's
    concurrent events; makes "did A know about B's change?" answerable in provenance.
11. **Speculative execution with cancellation** → run rival approaches concurrently,
    first-validated-wins, losers abandoned (jj makes abandonment free); formalizes
    judge-panel patterns as a scheduling primitive.
12. **Barriers/phasers** → mission phases where a crew synchronizes (all implementers
    land before the integrator starts) — declared in crew templates, visible in cockpit.

Next step: a deeper research pass (survey + feasibility ranking against the jj/journal
substrate) producing `04-concurrency-strategies.md`.
