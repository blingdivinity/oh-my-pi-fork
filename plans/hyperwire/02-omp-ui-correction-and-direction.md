# Hyperwire — Correction (omp-ui is the real base) & Updated Direction

> Follow-up to `01-reality-check-and-critique.md`. The owner confirmed the cockpit stack
> lives on `origin/omp-ui`. Re-verification against that branch reverses most of doc 01's
> Section 1 and materially raises the plans' credibility. This doc records (1) the
> re-verification, (2) the decisions now locked in, (3) what that does to phase ordering,
> (4) the patterns-vs-code analysis (open question under discussion), and (5) implications
> of "VCS work is core."

## 1. Re-verification against `origin/omp-ui`

`omp-ui` branches off the same v15.11.5 merge-base as `main` and carries ~3,000 changed
files. Verified present, exactly as the plans described:

| Claim (doc 01 called it false) | Status on omp-ui |
|---|---|
| `packages/wire`, `packages/collab-web`, `src/webui/`, `src/collab/`, `WEBUI-PARITY.md` | **All exist.** `gateway.requestToolApproval` is at `webui/gateway.ts:779` — the exact line Plan 3 cited. |
| arktype as the validation lib | **True.** `task/types.ts` and `eval/agent-bridge.ts` `import { type } from "arktype"`. |
| `canSpawnAtDepth()` | **Exists** (`task/types.ts:214`). |
| Global spawn semaphore, `invokedAt`/`acquiredAt` | **Exists** — process-global per-provider semaphores in `executor.ts` (~202–239), fields documented at ~354–361. |
| `AgentKind` includes `"advisor"` | **True** (`agent-registry.ts:31`). |
| `session-migrations.ts` / `session-entries.ts` as files | **Exist.** |
| Single-session weld | **Confirmed as the plans said**: `collab/host.ts` `#sessionId` (:124, :181, :278). |
| Wire identity gap | **Confirmed as the plans said**: `AgentEvent` carries no `agentId`; only `agent-cmd`/`fetch-transcript` frames do. `AgentSnapshot` has `parentId`. |

Conclusion: the plan documents were verified carefully — against omp-ui. Doc 01's
explorer sweeps ran on `main`.

### Addendum (owner clarification, 2026-07-02): what omp-ui actually is

- `omp-ui` = **upstream oh-my-pi at ~v16.1.23** (2026-06-26) **+ ~75 parity commits by
  the owner** (2026-06-27) polishing the web UI toward TUI parity. The wire/webui/
  collab/collab-web stack is **upstream infrastructure** (entered upstream ~v15.11.8),
  actively developed upstream — not the owner's prototype. The owner's layer is the
  parity work on top (slash-command parity, panels/modals, plus some durable backend
  session-API contracts, e.g. "Batch-1 backend contract — todos in state, goal ops,
  context breakdown").
- This fork's `main` (15.11.5) is a stale snapshot from **before the webui existed** —
  irrelevant as a base. `omp-ui` itself is behind current upstream and needs a refresh
  before anything builds on it.
- The owner is **not sure the parity direction is right for Hyperwire**. Assessment in
  §3a below: it isn't the foundation, but parts of it are durable inputs.
- Base strategy: refresh from latest upstream; treat wire/webui/gateway/tool-render as
  **upstream library surface** (widen via upstreamable patches or additive wrapping,
  never a hard fork); treat the parity commits as a separate concern (candidate for
  upstreaming, not a Hyperwire dependency).

### What survives from doc 01 after re-verification

1. **The eval kernel is the real orchestration incumbent** (`agent()`/`parallel()`/
   `pipeline()` in persistent kernels, same `runSubprocess`, in-memory data flow,
   schemas). Any declarative engine must justify itself on the artifact, not scheduling
   power. (Plans compare against swarm — the weaker incumbent.)
2. **`autoresearch/storage.ts`** remains an uncited in-repo precedent for the SQLite
   run ledger (M4): `sessions` + `runs`, keep/discard/crash provenance, commit-or-revert.
3. **`AgentProgress`** remains the ready-made agent-tile model the cockpit should bind to.
4. **Naming collision**: `src/capability/` (config-discovery providers) vs the proposed
   agent-permission "capabilities" (P5/M1). Rename the new system (grants / warrants /
   authority).
5. **No unified write chokepoint** (verified again on omp-ui): `write`/`edit modes`/
   `ast-edit` each write independently via their own writethrough; `bash` bypasses all.
   P5's "enforce locks at the write-tool boundary" must first *build* that boundary —
   or enforce at the hook layer (see §5).
6. **Commit-per-edit should name `utils/commit-message-generator.ts`** (one smol-model
   call) as its engine, not `commit/agentic` (CLI-shaped, heavy, staged-changes).
7. **Process-global singletons** (`MAIN_AGENT_ID`, `IrcBus`, `AgentRegistry`,
   `AgentLifecycleManager`) still bound the in-process forest; process-per-agent via RPC
   mode remains the unweighed alternative for heavy/long-lived peers.
8. **Fork-maintenance principle (new):** this fork actively tracks upstream
   (can1357/oh-my-pi). Additive changes (new packages, hooks, discovered definitions,
   new wire frames) are cheap to carry across upstream merges; refactors of hot core
   files (executor, edit tools, session-manager) are expensive. Prefer additive seams.

### Retracted from doc 01

- "Phantom stack" (§1.1), "arktype not in repo" (§1.2), "no global semaphore /
  no canSpawnAtDepth / no advisor kind" (§1.3), "migration files misnamed" (§1.4) —
  all artifacts of exploring `main`. The plans' Critical-files anchors are trustworthy
  on omp-ui.

## 2. Decisions locked in (owner, 2026-07-01)

1. **Core atom: Mission control.** Hyperwire v1 is a cockpit over a persistent forest of
   long-lived, steerable agents — attention routing, conversation, delegation. The
   experiment bench (pattern runs, A/B, replay/fork) is secondary/later.
2. **Tauri from day one.** The native shell is part of the product identity. Plan 1
   Step 9's sidecar analysis (non-compiled Bun sidecar to preserve the worker-host
   contract) stands and should be kept.
3. **VCS work is core.** Commit-per-edit + multi-agent concurrency in the working tree
   are not a Phase-4 afterthought; they need first-class design (see §5).
4. **Patterns vs code: undecided — under discussion** (see §4).

## 3a. Is the omp-ui parity direction right for Hyperwire? (owner's open doubt)

Short answer: **the parity webui is not the foundation, but it de-risked the foundation.**

- The parity work's product shape is a *mirror of one TUI session in a browser*. Mission
  control is a different product: forest-first, multi-session, attention-routed, with
  conversation as one pane among many. Evolving the mirror into the cockpit drags along
  parity obligations (every TUI slash flow) that a cockpit doesn't want, and couples
  Hyperwire to a UI surface upstream actively churns.
- What the parity exercise *proved and produced* that Hyperwire should keep:
  1. The **wire/gateway substrate works** — typed frames, approvals, transcripts,
     steering, agent-cmd over WS. Hyperwire consumes this, widened with origin ids.
  2. The **backend session-API contracts** added during parity (todos-in-state, goal
     ops, context breakdown, shared session APIs for /plan-review etc.) are exactly the
     control surface a cockpit binds to — durable regardless of which UI renders it.
  3. **tool-render/** per-tool renderers are reusable presentation components.
  4. The **parity matrix** is a map of which TUI capabilities exist as remote-drivable
     APIs vs TUI-only code paths — the exact gap list a cockpit hits later.
- Recommended relationship: Hyperwire cockpit is a **new app** (Tauri shell + its own
  React frontend) speaking a widened wire protocol, importing tool renderers and
  session-API contracts as libraries. The parity webui stays what it is — an upstream
  feature the owner improved — and its improvements become upstream PRs, not
  Hyperwire carry-weight.

## 3. What mission-control-first does to the roadmap

Plan 1's Phase 1 (pattern engine) was the experiment bench's organ. With mission control
chosen, **Plan 1's Phase 2 (forest cockpit) is promoted to Phase 1**, and the pattern
engine is demoted until §4 resolves. The good news: omp-ui's existing stack is much
closer to mission control than to the bench — `wire` already has `agent-cmd`
(chat/kill/revive) and `fetch-transcript`; `AgentSnapshot` already has `parentId`; the
registry already models park/revive lifecycle. The known gaps are exactly the ones Plan 1
Phase 2 lists: no `agentId` on `AgentEvent`, single-`#sessionId` weld, flat panel +
single polling drawer, process-local ids, live-only attention semantics.

Revised shape (to be step-decomposed after §4/§5 land):

- **Phase 1 — Forest cockpit in Tauri.** Widen wire with origin (`runId`/`agentId`/
  `parentId`) on every frame; relax the single-session weld so the gateway observes the
  whole `AgentRegistry`; forest tree + multi-pane live view with retained history;
  attention-first default view (P1: surface only what needs judgment); steering/chat/
  kill/revive per agent from the cockpit; Tauri shell with the Bun sidecar.
- **Phase 2 — Mission primitives.** Crew/mission templates (§4); grant-escalation
  generalized from `requestToolApproval` (M1 — its anchor is real); persistent-peer
  lifecycle policy (beyond the 7-min park TTL); the SQLite journal (M4 shape) recording
  all forest activity (task, eval, swarm, cockpit-launched missions) uniformly.
- **Phase 3 — VCS plane** (§5): per-agent change visibility in the cockpit,
  commit-per-edit, concurrency model decision (locks vs isolation vs jj).
- **Phase 4 — Bench organs, if/when needed:** DAG pattern engine, replay(cached|live)/
  fork-from-node, A/B — all journal-native.

## 4. Patterns vs code (the open question) — analysis

The question is really *"what is the declarative surface of orchestration?"* Three jobs
get conflated:

**(a) Composition** — who is on the mission: agent types, briefs, models, budgets,
spawn rights, permission profiles. Naturally *data*. Today this is `AgentDefinition`
markdown + `spawns` + settings; the plans' "compose profiles" (P3) and capability
profiles (M1) live here.

**(b) Control flow** — loops, retries, conditionals, dynamic fan-out driven by
intermediate results. Naturally *code*. The eval kernel already does this well, and
every DAG language that tries to absorb it grows into a bad programming language
(Plan 2 P7's own anti-DSL rule).

**(c) The record** — what actually happened: who spawned whom, with what inputs, at
what cost, producing what. Naturally *data*, and — crucially — derivable *regardless of
how the orchestration was authored*, if the spawn path journals uniformly.

Plan 1's pattern spec welds (a)+(b) into one JSON5 artifact and hopes (c) falls out of
executing it. Under mission control, most orchestration is **dynamic** — the structure
emerges from agent decisions mid-mission — so a pre-declared DAG describes only the
minority of real forests. The cockpit must render *emergent* structure anyway (from the
registry + journal), which means (c) cannot depend on (a)/(b) being declared.

**Recommendation (Option C, mission-control-shaped):**

- **Build (a) as data now — "crew templates" / mission playbooks.** A named, discovered
  definition (`.omp/crews/*.md` or `.json5`, mirroring agent discovery): cast list
  (agent types + counts + briefs as Handlebars templates), policy envelope (budget,
  spawn rights, permission profile, model tiers), and optionally a coarse topology
  (who reports to whom — for the cockpit's initial layout, not for scheduling).
  Cheap to build (extends existing discovery), maximal velocity, agents can author them
  by writing files (P3's reflexive horizon), and the cockpit gets a "launch mission"
  affordance with a legible plan.
- **Keep (b) in code.** Orchestrator agents use eval/`task` as today; host-side
  scripted orchestration gets a thin typed TS API later if needed. No DAG language in v1.
- **Build (c) as the universal journal now** (Phase 2): every spawn — task tool, eval
  `agent()`, swarm, cockpit launch — records the same node row (definitionHash,
  rendered prompt, model, parent, cost, outcome). Replay/fork/A-B (P2) attach to the
  journal later without re-litigating authoring.
- **Defer the DAG pattern engine** until a real experiment-bench need shows up; when it
  does, it is one more frontend emitting the same journal, and swarm subsumption
  (Plan 1 Phase 3) happens then.

What this deliberately gives up, so the trade is explicit: no validate-before-run of a
full data-flow graph; no static diffable artifact for *control flow* (only for
composition + the post-hoc journal); "compare two orchestration strategies" means
comparing journals, not specs. If those losses feel central rather than acceptable,
that is the signal the experiment bench matters more than currently ranked.

## 5. "VCS work is core" — implications and options

Mission control + core VCS means: many agents changing real repos concurrently, with
the cockpit showing per-agent change provenance and safe conflict behavior. Three
strategies, not mutually exclusive:

- **S1 — Keep CoW isolation + branch/delta merge (exists), add visibility.** Per-agent
  diffs in the cockpit (jj/git diff providers exist), task branches (`omp/task/<id>`)
  surfaced as first-class mission artifacts, merge review as a cockpit flow. Zero core
  refactor; upstream-merge-friendly. Weakness: siblings don't see each other's edits
  until merge.
- **S2 — Shared worktree with locking at the hook layer (additive).** Instead of
  refactoring all write tools onto a new chokepoint (expensive, upstream-hostile),
  enforce at `HookToolWrapper`: on `tool_call` for known write tools, extract the target
  path(s), acquire a worktree+path lock (generalized `withFileLock`); release on
  `tool_result`. Typed "file locked by <agent>" error on contention. Known hole: bash
  writes — mitigate by policy (bash-heavy agents run isolated) and detection, not by
  pretending the hole closed. Needs: lock manager exposure to hooks/kernel, path
  extraction per write tool.
- **S3 — jj-native commit plane.** Working-copy snapshotting gives commit-per-change
  for free; the op log gives forest-wide undo + provenance; first-class conflicts make
  concurrent integration tractable. This is the *principled* answer to "commit-per-edit
  + beads" — but `utils/jj.ts` is read-only today, pure-jj repos are explicitly
  rejected, and building it is a real investment that diverges from upstream.

Commit-per-edit itself is buildable **additively today** on any of S1–S3: a
`tool_result` hook on edit/write → `withRepoLock` → commit with
`utils/commit-message-generator.ts` (or a fixed template + async message backfill),
recording entryId↔SHA provenance in the journal. Missing plumbing: hooks can't currently
reach `withRepoLock`/`withFileLock` or a commit API (`HookContext` has only
`exec`/`ui`/read-only session) — expose them.

Open sub-questions for the owner:
1. Should sibling agents in one mission *see each other's edits live* (argues S2/S3) or
   is isolate-then-merge acceptable when the cockpit makes merges visible (S1)?
2. Is jj-native investment on the table for v1, or is git-first with jj-as-diff-source
   the v1 constraint (S3 deferred)?
3. Commit granularity: literally per-edit-tool-call, per-turn, or per-"logical change"
   (agent-declared checkpoints)? Per-edit maximizes provenance but makes history noisy;
   jj's snapshot+squash model handles this gracefully, git needs a squash policy.
