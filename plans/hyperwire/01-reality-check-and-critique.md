# Hyperwire — Codebase Reality Check & Plan Critique

> ⚠️ **SUPERSEDED IN PART — read `02-omp-ui-correction-and-direction.md` first.**
> This document was produced by exploring the **wrong base branch** (`main` =
> upstream v15.11.5). The plans were verified against **`origin/omp-ui`**, where the
> "phantom" cockpit stack, arktype, `canSpawnAtDepth`, the global provider semaphores,
> the `advisor` kind, and `session-migrations.ts` all exist exactly as the plans claim.
> Section 1 below is therefore mostly an artifact of the wrong base; the doc is kept
> because Sections 2–3 (unused assets, design tensions) largely survive re-verification.
> `02-…` records what survives, what's retracted, and the updated direction after the
> owner's decisions (mission control, Tauri day one, VCS core).

> Produced by a fresh, independent exploration of this checkout (fork of oh-my-pi at v15.11.5,
> branch `claude/hyperwire-design-planning-k2bu05`). The three prior plan documents
> (transformation plan, Houyhnhnm pass, dynamic-substrate mining) were treated as untrusted
> input and every load-bearing claim was re-verified against the tree. This file records
> (1) factual corrections, (2) assets the plans miss, (3) the unresolved design tensions,
> and (4) a sharpened counter-proposal to react to.

## 1. Factual corrections (plans vs. this repo)

### 1.1 The cockpit stack the plans call "verified" does not exist here — SEVERE

None of the following exist anywhere in this checkout:

- `packages/wire` (no `GuestFrame`/`HostFrame`/`WireFrame`, no `AgentSnapshot`, no `COLLAB_PROTO`)
- `packages/collab-web` (no `GuestClient`, no `AgentsPanel`/`AgentDrawer`, no `tool-render/`, no `ToolRenderHost`)
- `packages/coding-agent/src/webui/` (no `SessionGateway`, no `startWebServer`, no `isLoopbackRequest`, no `requestToolApproval`)
- `packages/coding-agent/src/collab/` (no `CollabHost`, no `protocol.ts`)
- `WEBUI-PARITY.md`, `omp --mode web`

`git diff main...HEAD` is empty; `grep -ri hyperwire` returns nothing. Plan 1's entire
"Cockpit / observability" section, Plan 1 Phase 2, and Plan 3's M1 (which calls
`gateway.requestToolApproval` a "VERIFIED seam" with line numbers) are anchored to phantom
code. Either this work exists unpushed on another machine/branch, or a prior planning session
confabulated its verification. **This must be resolved before any plan is executable.**

What actually exists as observability/protocol substrate:

- **RPC mode** (`src/modes/rpc/`): NDJSON over stdio; `RpcCommand`/`RpcResponse`;
  `get_subagents` / `get_subagent_messages` (byte-offset transcript polling);
  subscription levels `off|progress|events`; a typed `RpcClient` that spawns the agent
  as a subprocess. No HTTP/WS, no auth, no protocol version constant.
- **ACP mode** (`src/modes/acp/`): genuinely multi-session (`#sessions: Map`), has a real
  `PROTOCOL_VERSION`, elicitation-based approvals, `agentId = "acp:${sessionId}"`.
- **EventBus** (process-local) with `task:subagent:{event,progress,lifecycle}` channels.
- **Two parallel, drifted consumers** of those channels: `RpcSubagentRegistry`
  (deletes terminal agents — live-only by design) and `SessionObserverRegistry`
  (retains terminal, but single-main, wiped on session switch, two levels deep).
- **TUI HUD**: flat live list of direct children (`renderSubagentHudLines`), rich per-agent
  render logic in `task/render.ts` (~1400 lines).
- **`packages/stats`**: a shipping local React dashboard (Bun server + embedded client +
  SQLite + sync worker) — usage analytics, not live agents, but the GUI packaging precedent.

### 1.2 arktype is not in this repo — MODERATE

All three plans specify arktype schemas. Grep finds zero arktype usage. Validation here is
**zod/v4** (`task/types.ts`, eval bridges) plus a zod-backed TypeBox shim
(`extensibility/typebox.ts`) for tool params. Swarm's YAML validation is hand-rolled string
checks over `Bun.YAML.parse`. Use zod, or make adding arktype an explicit new-dependency
decision — not an inherited "the repo's validation lib" premise.

### 1.3 Spawn/concurrency contract misstated — MODERATE

- `canSpawnAtDepth()` does not exist. Depth gating is inline: `task.maxRecursionDepth`
  (default 2) → `atMaxDepth` strips `task` from the child toolset (`executor.ts`).
- "runSubprocess has its own global subagent semaphore (`invokedAt`/`acquiredAt` in
  `ExecutorOptions`)" — false. No such fields. The only limiter is a `Semaphore` **per parent
  task-tool instance** (`task/index.ts`, `task.maxConcurrency`). There is **no forest-wide
  concurrency cap**; N parents ⇒ N independent semaphores. A kernel must bring its own
  global budget; nothing exists to "not reimplement."
- `runSubprocess` never registers agents; **`createAgentSession` does** (`sdk.ts`, keyed by
  `agentId ?? parentTaskPrefix ?? MAIN_AGENT_ID`). `runSubprocess` only flips status and
  adopts into the lifecycle manager. Matters if the kernel ever bypasses `runSubprocess`.
- `AgentRegistry.kind` is `"main" | "sub"` — there is no `"advisor"` kind.
- The registry tree is **metadata, not structure**: `parentId` is recorded, but visibility
  (`listVisibleTo`) and IRC routing are flat (every alive agent sees every other).

### 1.4 Persistence/migration files misnamed — MINOR

`session-migrations.ts` and `session-entries.ts` do not exist; entries + migration chain
(v1→v2→v3) live inside `session-manager.ts` (3.7k lines). There are already **four divergent
migration conventions**: in-file JSONL chain (session-manager), `schema_version` table
(`agent-storage.ts`, SCHEMA_VERSION=5), `PRAGMA user_version` (`autoresearch/storage.ts`),
and shape-inference rebuild (`history-storage.ts`). Plan 2 P6's "one unified contract"
instinct is right — but it should name which convention wins (recommend: `agent-storage.ts`'s
`schema_version` table style for SQLite, session-manager style for JSONL).

### 1.5 Commit-per-edit points at the wrong engine — MODERATE

`src/commit/` is real but **CLI-shaped and heavy**: resolves a primary + smol model, loads
project context, runs an agentic loop or map-reduce with retries and changelog generation,
reads *staged* changes, writes to stdout. Not callable per-edit. The realistic primitive the
plans should name is **`utils/commit-message-generator.ts`** — one smol-model call, 4k-char
diff cap, 60 max tokens — already injected as the `commitMessage` callback for task-branch
commits (`worktree.ts` `commitToBranch`).

Further gaps for commit-per-edit / shared-worktree (Phase 4):

- **No unified write chokepoint.** `WriteTool`, `edit/modes/replace.ts`, `patch.ts`,
  `ast-edit`, notebook edits each call `Bun.write` independently; `bash.ts` writes entirely
  outside all of them. The closest shared point is `invalidateFsScanAfterWrite()` — a
  fire-and-forget cache invalidation, not an interception seam. "Enforce locks at the write
  tool boundary" first requires *building* that boundary.
- **Locks aren't reachable from hooks.** `withRepoLock` (in-process promise chain per repo
  root) and `withFileLock` (cross-process mkdir-lock with owner tokens + stale reaping,
  default staleMs 10s) exist but neither is exposed through `HookAPI`; example hooks shell
  out via `pi.exec`, bypassing both.
- Current isolation philosophy is the **opposite**: per-subagent CoW clones (`pi-iso`:
  apfs/btrfs/zfs/reflink/overlayfs/projfs/rcopy) + synthetic-tree delta patches +
  cherry-pick merge under `withRepoLock`. Shared-worktree-with-locks is an inversion, not an
  extension. (Not a reason not to do it — a reason to cost it honestly.)
- **jj is read-only** (`utils/jj.ts`: diff + repo resolution, zero mutating ops). If
  commit-per-change provenance is truly wanted, jj-native working-copy snapshots + the op
  log are arguably the *right* substrate — but that's a build, not a wiring job.

### 1.6 Smaller corrections

- Swarm's context flow between agents is **filesystem-only** (ordering edges only; no data
  edges, no prompt injection of upstream outputs). The plans' "orchestration-as-data fixes
  swarm" is right, but the plans understate that swarm also has *no data plane at all*.
- Swarm's `StateTracker.load()` resumability exists but is only wired to `/swarm status`;
  `/swarm run` always starts fresh.
- `prompt.render` (Handlebars) is exported from `@oh-my-pi/pi-utils` — confirmed.
  `Snowflake` — confirmed. `Bun.JSON5` — confirmed per AGENTS.md.
- Naming collision: `src/capability/` already means **config-discovery providers**
  (load MCP/skills/etc. from `.omp`/`.claude`/`.codex` roots). A new agent-permission
  system called "capabilities" will collide in code and conversation. Pick another word
  (grants, warrants, authority, permits).

## 2. Assets in the repo the plans don't use

1. **The eval kernel is the real orchestration incumbent, not swarm.** `agent()`,
   `parallel()`, `pipeline()` inside persistent JS/Python kernels call the same
   `runSubprocess`, with in-memory data flow, structured-output schemas, depth/spawn
   guards, bounded pools sized by `task.maxConcurrency`. Code-as-orchestration here already
   dominates a declarative DAG on expressiveness. A pattern engine's differentiated value is
   only: static inspectable artifact, validate-before-run, provenance keying,
   cockpit-renderable topology, diffable/forkable specs.
2. **ACP already solves multi-session + protocol versioning.** If the cockpit needs "N
   sessions in one host with stable ids and versioned frames," extending ACP (or copying its
   shape) beats inventing wire-v2 from scratch.
3. **RPC mode + `RpcClient`** is an existing, typed way to run each agent as a *real*
   subprocess and drive it — the escape hatch from every process-global singleton
   (`MAIN_AGENT_ID`, `IrcBus`, `AgentRegistry`, `AgentLifecycleManager` are all per-process).
4. **`AgentProgress`** (`task/types.ts`) is a ready-made rich agent-tile model: status,
   current/recent tools, recent output, tokens, context, cost, retry state, nested inflight
   tasks. The cockpit's per-agent state should *be* this, not a new invention.
5. **`autoresearch/storage.ts`** is an in-repo precedent for exactly the run ledger Plan 3
   M4 proposes: SQLite `sessions` + `runs`, per-run provenance (commit, metrics,
   keep/discard/crash status, modified paths), commit-or-revert semantics, flagging.
6. **`session_init` entries** already snapshot each subagent invocation (systemPrompt, task,
   tools, outputSchema) "for debugging/replay" — the seed of node-level provenance.
7. **`history://<agentId>`** already serves any registered agent's transcript;
   `local://` + shared `parentArtifactManager` already give forest-unique artifact ids
   (Plan 3 M5's `contextRefs` substrate exists).
8. **Hooks** provide a real per-tool-execution boundary (`tool_call`/`tool_result`, typed
   per tool) with shipping examples (`git-checkpoint.ts`, `auto-commit-on-exit.ts`) — 80% of
   a commit-per-edit MVP, minus lock/commit-API access and bash-write coverage.
9. **`packages/stats`** shows the house pattern for a local web GUI (Bun server + embedded
   React client, no Tauri).

## 3. Design tensions the plans leave unresolved

### T1 — What is Hyperwire's atom: the *run* or the *agent*?

`runSubprocess` is request/response: spawn → drive to `yield` → `SingleResult` (the session
lingers parked afterward, reachable only via IRC/history). Perfect for DAG nodes. Wrong shape
for the stated vision — "the forest outlives any session," orchestrators as durable peers,
a cockpit where you steer and converse. That vision wants **long-lived session handles**
(`createAgentSession` + `steer`/`followUp` + IRC), a different lifecycle (no 7-minute park
TTL churn), and a per-agent resource story (each live session can hold LSP/MCP child
processes). The plans build a batch scheduler in Phase 1 while describing a persistent-agent
mission control in the vision section. These are two different products:

- **(A) Mission control**: few long-lived, steerable agents; cockpit = attention router;
  orchestration is ad-hoc/conversational; provenance is session-tree-shaped.
- **(B) Experiment bench**: many ephemeral runs of declared patterns; cockpit = run browser
  + DAG viewer; provenance is run-ledger-shaped; A/B and fork are first-class.

Both are buildable from these primitives, but the kernel API, the lifecycle model, the wire
protocol, and the Phase-1 milestone differ. Pick a center of gravity.

### T2 — Declarative patterns vs. code-as-orchestration

The eval kernel already executes arbitrary agent DAGs with data flow. Agents can already
author orchestration by writing eval code. So "orchestration-as-data" must justify itself on
the *artifact* value (inspect/validate/diff/fork/compare/render), not scheduling power.

Counter-proposal: **make the run journal the first-class research object, not the pattern.**
Any orchestration — a JSON5 pattern, a TS script against a thin `hw.agent()`/`hw.parallel()`
API, an eval-kernel session, even a swarm run — records the same journal: per-node
`(definitionHash, renderedPrompt, model, upstream refs) → output`, statuses, costs. Replay,
fork-from-node, and A/B operate on **journals**. The declarative pattern is then *one
authoring frontend* (sugar that compiles to the same API), addable later without blocking
anything. This preserves priority #1 (velocity: nobody has to learn/maintain a workflow
language before shipping value) and still delivers the provenance/fork/A-B goals of Plans
2–3 (P2 inputHash, M4 SQLite ledger survive unchanged — they attach to the journal, not the
pattern spec).

If a declarative spec is still wanted in Phase 1, keep it minimal (nodes, needs, prompt
templates) and enforce Plan 2 P7's anti-DSL rule hard: no retry policies, no expressions, no
conditionals — a node that needs logic is a code node.

### T3 — In-process kernel vs. process-per-agent

The plans commit to in-process recomposition without pricing it:

- Every coordination primitive is a **process-global singleton** (`MAIN_AGENT_ID = "Main"`,
  `IrcBus.global()`, `AgentRegistry.global()`, `AgentLifecycleManager.global()`).
  Two co-equal orchestrators in one process collide on "Main," UI relay, and mailboxes.
- Live agents are heavy (LSP/MCP children, artifact managers, extension runners) with no
  global cap; park/revive churn replays full JSONL per revival.
- One in-process crash takes the whole forest down.

Alternative the plans never weigh: the cockpit/kernel process orchestrates, and **long-lived
or heavy agents run as `omp --mode rpc` child processes** (existing typed protocol, existing
`RpcClient`), while cheap ephemeral nodes stay in-process via `runSubprocess`. Process
boundaries make the singletons *correct by construction* (one Main per process), add crash
isolation, and give the cockpit a uniform frame source. Cost: transcript/artifact plumbing
across the boundary, N× startup. This is a genuine fork, not a default.

### T4 — Phase ordering contradicts the stated priorities

Priority #1 (extension velocity) is **largely already served**: new agent-type = one
markdown file; new tool = one `.ts` factory file; both hot-discovered, per-session bound,
gateable per agent. The genuinely missing thing is priority #2: **any GUI at all** — and the
identity layer under it. Meanwhile Phase 1 builds a pattern engine whose scheduling power
duplicates eval, and Phase 2 (cockpit) is anchored to phantom code.

The keystone both directions share: **events are identity-free by construction.**
`AgentEvent`/`AgentSessionEvent` carry no agentId/sessionId/runId; identity is bolted on
only at the subagent-wrapper hop (`SubagentEventPayload.id`); approvals/UI-requests carry no
agent correlation; registries are live-only or single-main. Whatever ships first, the
`(runId, agentId, parentId)` tagging + a *retained* forest store must exist. That argues for
inverting the phases: identity/journal layer first, minimal cockpit over **existing**
activity (task fan-outs, eval agents, swarm runs) second, new orchestration engine third —
by then the cockpit shows you what the engine needs to be.

### T5 — Tauri-from-day-one is unforced

The Tauri sidecar analysis in Plan 1 (non-compiled Bun sidecar to preserve the worker-host
contract) is genuinely good research — but it solves a packaging problem Phase 1 doesn't
have to have. `packages/stats` already demonstrates the low-friction path: Bun HTTP+WS
server + embedded React client, opened in a browser. Transport-identical to a future Tauri
shell (its own rationale says so). Recommend: browser-first, Tauri when the cockpit earns a
native shell.

### T6 — Things in Plans 2–3 worth keeping as-is

- Honest replay split (`cached` vs `live`), never claiming determinism — keep.
- `inputHash` / `definitionHash` distinction — keep (attach to journal).
- SQLite run ledger + per-run `events.jsonl` (M4) — keep; model on `agent-storage.ts` +
  `autoresearch/storage.ts`.
- Capability *escalation* routed like approvals (M1) — keep the concept; re-anchor to the
  real approval surfaces (`tools/approval.ts` tiers, extension-UI `confirm`, ACP
  elicitation) instead of the phantom gateway; rename away from "capability."
- Gradual `outputSchema` on nodes (M3) — keep, in zod; eval's `agent({schema})` already
  proves the shape.
- Content-addressed shared context (M5) — keep; build on `parentArtifactManager`.
- Anti-goals (no Self/Smalltalk rewrite, no distributed eval now, no compute-plane
  subprocess, no mandatory schemas) — keep all.
- Cockpit shows only attention-worthy items by default (P1) — keep; this is the actual
  product thesis of the cockpit.

## 4. Sharpened proposal (to react to, not to obey)

- **Phase 0 — Identity + journal (the keystone).** An `AgentOrigin` envelope
  (runId/agentId/parentId) applied at the boundaries (wrap events as
  `SubagentEventPayload` already does — don't rewrite `packages/agent`); unify
  `RpcSubagentRegistry`/`SessionObserverRegistry` into one **retained** forest store built on
  `AgentProgress`; SQLite run/node journal (autoresearch-style) written by the task
  executor and eval bridge, so *existing* activity is already recorded.
- **Phase 1 — Cockpit MVP over existing activity.** Bun server + WS + React (stats-style
  packaging, loopback+token). Forest tree with retained history, agent tiles bound to
  `AgentProgress`, transcript view (JSONL tail / `history://`), approval surfacing.
  You watch today's task/eval/swarm traffic in a GUI before writing any new engine.
- **Phase 2 — Orchestration API + journal-native provenance.** A thin typed `hw` API
  (agent/parallel/pipeline over `runSubprocess`, journal-recording, global budget semaphore);
  replay(cached|live)/fork-from-node over journals; JSON5 pattern loader as optional sugar.
- **Phase 3 — Persistent peers (if that's the center of gravity: possibly swaps with 2).**
  Long-lived agent handles (`createAgentSession` or RPC children), steer/converse from the
  cockpit, lifecycle policy beyond park-TTL, grant-escalation flow.
- **Deferred/optional:** shared-worktree file locking or jj-native commit-per-change
  (decide after the cockpit shows whether merge conflicts actually hurt); Tauri shell;
  remote placement seam.

## 5. Open questions for the project owner

1. Does the webui/wire/collab-web stack exist somewhere unpushed, or is the cockpit
   greenfield? (Determines whether Phase 2 of Plan 1 is a refactor or an invention.)
2. Mission control (persistent steerable peers) or experiment bench (pattern runs +
   A/B/fork) — which is the center of gravity for v1?
3. Is a declarative pattern format a v1 requirement, or is a typed TS orchestration API +
   journal acceptable as the first authoring surface?
4. How load-bearing are commit-per-edit and shared-worktree concurrency (Phase 4)? Is
   jj-native investment on the table, or is git + existing CoW isolation fine for v1?
5. Browser-first cockpit acceptable, or is the native Tauri shell itself part of the point?
