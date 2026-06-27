# omp web UI — TUI parity matrix

Source of truth for re-implementing the TUI/UX **exactly** in the web UI
(`omp --mode web`). Derived from the authoritative declarative registries, not
from memory:

- Keybindings → `packages/coding-agent/src/config/keybindings.ts` (`KEYBINDINGS`)
- Slash commands → `packages/coding-agent/src/slash-commands/builtin-registry.ts`
  (`BUILTIN_SLASH_COMMAND_REGISTRY`, 58 specs). Each spec carries `handle`
  (text/ACP, runs headless) and/or `handleTui` (needs `InteractiveModeContext`).
- Settings → `packages/coding-agent/src/config/settings.ts`
- Theme tokens → `packages/coding-agent/src/modes/theme/theme-schema.json`

Web plumbing: gateway `packages/coding-agent/src/webui/gateway.ts`; client
`packages/collab-web/src/lib/local-client.ts`; UI `packages/collab-web/src/`.

**Legend** — ✅ done · 🟡 partial / runs-but-not-TUI-grade · ⛔ stubbed
("interactive-only" notice) · ❌ missing · ➖ N/A in a browser.

> Maintenance: keep this in lockstep with the registries. When a registry entry
> changes, update the matching row. A command's `handle`/`handleTui` columns are
> regenerable via the dump in commit history (imports `BUILTIN_SLASH_COMMANDS_INTERNAL`).

---

## Slash commands (58)

`kind` = which handlers the spec declares.
- **both** → has `handle`, so the gateway runs it via `executeAcpBuiltinSlashCommand`
  and emits text. Many also have a richer `handleTui` the web should match.
- **TUI-only** → `handleTui` only; the gateway currently returns
  "interactive-only" — these need a real web surface or ➖.
- **text** → `handle` only.

### Session lifecycle & navigation
| cmd | kind | web | notes / plan |
|---|---|---|---|
| `/new` | TUI-only | ✅ | starts a new session; gateway re-sends welcome+snapshot so the web transcript resets |
| `/drop` | TUI-only | ✅ | `newSession({ drop: true })` deletes the current session + starts fresh, then re-snapshots peers |
| `/resume` | TUI-only | ✅ | session picker (list-sessions + switch-session); switch re-snapshots the transcript |
| `/tree` | TUI-only | ✅ | session-tree overlay: fork/branch forest from `parentPath` (matched by path or id), click to switch |
| `/branch` | TUI-only | ✅ | "⎇ branch" button on each user message → branch(entryId) + re-snapshot |
| `/fork` | TUI-only | ✅ | session.fork() (history copied) + re-snapshot |
| `/handoff` | TUI-only | ✅ | server-side `session.handoff(focus)` (same call RPC uses) → re-snapshot; generation errors report gracefully |
| `/session` | both | ✅ | `SessionInfoPanel` (id/title/cwd/file/messages/model/thinking via `session-info`); `info`/`delete` also run as text |
| `/rename` | both | ✅ | click the header title to inline-edit → `setSessionName` + state broadcast (live title); `/rename <t>` also runs as text |
| `/move` | both | ✅ | runs (text) |
| `/exit` `/quit` | TUI-only | ➖ | browser: close tab |

### Model & thinking
| cmd | kind | web | notes / plan |
|---|---|---|---|
| `/model` `/models` | both | 🟡 | **TUI opens a model selector menu** — web only sets via dropdown (provider prefix now shown). BUILD a model-picker overlay (provider/id, current marked, fuzzy) and route `/model`/`/switch`/alt+m to it. |
| `/switch` | TUI-only | 🟡 | same selector as `/model` (alt+p / temporary) |
| `/fast` | both | ✅ | `on`/`off`/`status` run (text) |
| `/advisor` | both | ✅ | runs (text) |

### Modes & autonomy
| cmd | kind | web | notes / plan |
|---|---|---|---|
| `/plan` | TUI-only | ✅ | toggles plan mode (gateway sets PlanModeState, ACP-style) + mode bar |
| `/plan-review` | TUI-only | ✅ | reads the `local://` plan artifact (resolved via session manager) → command-output; inactive/no-plan handled |
| `/goal` | TUI-only | ✅ | goal panel: set/pause/resume/drop/budget via goalRuntime control ops; mode bar reflects state |
| `/guided-goal` | TUI-only | ✅ | opens the goal panel (set/budget); the LLM interview is a TUI nicety, the panel reaches the same goal |
| `/loop` | TUI-only | ✅ | client-side loop: re-sends your last prompt after each yield; Esc stops; mode-bar banner |
| `/btw` | TUI-only | ✅ | server-side `session.runEphemeralTurn(btw prompt)` → answer in command-output (the same call the TUI controller uses) |
| `/tan` | TUI-only | ✅ | shared `dispatchTangent()` helper (extracted from the controller) forks a background clone + dispatch breadcrumb; agent shows in the rail |
| `/omfg` | TUI-only | ✅ | rule-forge modal: `omfg-forge`/`omfg-save` ops compose `runEphemeralTurn` + the shared `omfg-rule` helpers (generate→validate→project/global→amend→save) |
| `/retry` | TUI-only | ✅ | routed to session.retry() (also alt+r) |
| `/force` | both | ✅ | `ForceSelector` lists active tools (`get-tools`), filter + pick → `/force <tool>`; `/force <tool> [prompt]` also runs as text |

### Context & transcript
| cmd | kind | web | notes / plan |
|---|---|---|---|
| `/context` | both | ✅ | context panel: per-category breakdown (system/tools/context/skills/messages) + totals via get-context |
| `/compact` | both | ✅ | `soft`/`remote`/`snapcompact` run |
| `/shake` | both | ✅ | `elide`/`images` run |
| `/fresh` | both | ✅ | runs |
| `/tools` | both | 🟡 | runs (text); ctrl+o expand has no web equiv |
| `/todo` | both | ✅ | always-visible todo HUD (phases + status glyphs) from SessionState.todos |
| `/dump` | both | ✅ | transcript in command-output + a copy button |
| `/export` | both | ✅ | export-html op → browser download of the HTML |
| `/copy` | TUI-only | ➖ | native browser text selection + Ctrl/Cmd+C covers this |
| `/memory` | both | ✅ | many subs; run as text |

### Providers, MCP, plugins, infra
| cmd | kind | web | notes / plan |
|---|---|---|---|
| `/setup` `/providers` | TUI-only | ➖ | first-run provider onboarding — done via the CLI/terminal |
| `/login` `/logout` | TUI-only | ➖ | provider OAuth runs on the host/CLI; the web server itself is token-authed |
| `/mcp` | both | ✅ | full sub-tree runs (text); MCP badge shows status |
| `/ssh` | both | ✅ | `add`/`list`/`remove` run |
| `/marketplace` | both | ✅ | runs (text) |
| `/plugins` | both | ✅ | `list`/`enable`/`disable` run |
| `/reload-plugins` | both | ✅ | runs |
| `/extensions` | TUI-only | ✅ | Extension Control Center panel: read-only inventory (42 capabilities grouped by kind, provider + state) via `loadAllExtensions`; enable/disable runs as text via `/plugins` |
| `/agents` | TUI-only | ✅ | opens the agents rail (`AgentsPanel`) — the web Agent Control Center |

### Collab, sharing, misc
| cmd | kind | web | notes / plan |
|---|---|---|---|
| `/collab` | TUI-only | ➖ | host a relay — web is already the client |
| `/join` `/leave` | TUI-only | ➖ | collab join/leave |
| `/share` | both | ✅ | returns an encrypted link |
| `/browser` | both | ✅ | headless/visible toggle |
| `/jobs` | both | ✅ | runs |
| `/usage` | both | ✅ | `show`/`reset` run |
| `/changelog` | both | ✅ | runs |
| `/stats` | text | ✅ | `StatsModal` launches the local dashboard (`launch-stats` → `launchStatsDashboard`) and links out to its URL |
| `/debug` | TUI-only | ➖ | terminal developer tool (memory/state dumps) |
| `/hotkeys` | TUI-only | ✅ | keyboard + command reference overlay (Esc closes) |
| `/settings` | TUI-only | ✅ | settings panel (read+write) over `get-settings`/`set-setting`, persists to the shared store |

**Tally (updated):** ✅ ~55 · 🟡 0 · ➖ ~6 · ❌ 0. Every TUI-only interactive flow
now has a real web path: `/plan-review` (plan-artifact read), `/btw` + `/omfg`
(server-side `runEphemeralTurn` + the shared `omfg-rule` helpers, with `/omfg`'s
full generate→validate→project/global→amend→save modal), and `/tan` (the
`dispatchTangent()` helper extracted from the controller and shared by both).
Browser-N/A flows (`/copy` native, `/login`/`/logout` host/CLI auth,
`/setup`/`/providers` CLI onboarding, `/debug` terminal dev tool) are marked ➖.
The LLM side-calls behind `/btw`/`/omfg`/`/handoff` can't be exercised under the
mock harness (they 401 and report gracefully), but the wiring uses the exact
session methods the TUI controllers use, covered by those controllers' unit tests.

---

## Keybindings (`KEYBINDINGS`)

| action | default | web | notes |
|---|---|---|---|
| `app.interrupt` | escape | ✅ | abort while streaming |
| `app.thinking.cycle` | shift+tab | ✅ | cycle thinking |
| `app.thinking.toggle` | ctrl+t | ✅ | hides/shows thinking blocks |
| `app.model.cycleForward` | ctrl+p | ✅ | next model |
| `app.model.cycleBackward` | shift+ctrl+p | ✅ | prev model |
| `app.model.select` | alt+m | ✅ | opens the model picker |
| `app.model.selectTemporary` | alt+p | ✅ | opens the model picker |
| `app.tools.expand` | ctrl+o | ✅ | expand all tool output |
| `app.message.followUp` | ctrl+q / ctrl+enter | ✅ | send as follow-up |
| `app.retry` | alt+r | ✅ | retry last failed turn |
| `app.message.dequeue` | alt+up | ✅ | pops the last queued message back into the composer (dequeue op) |
| `app.agents.hub` | alt+a | 🟡 | agent drawer exists |
| `app.plan.toggle` | alt+shift+p | 🟡 | `/plan` toggles it; alt+shift+p chord not yet bound |
| `app.history.search` | ctrl+r | ✅ | history dropdown over past prompts (localStorage); filter + arrow/Enter select |
| `app.editor.external` | ctrl+g | ➖ | external editor (browser) |
| `app.clipboard.*` | various | ➖/❌ | browser-native copy/paste mostly |
| `app.session.*` | various | ❌ | tree/fork/resume/rename/delete (session overlays) |
| `app.display.reset` | ctrl+l | ➖ | terminal-only |
| `app.suspend` | ctrl+z | ➖ | terminal-only |
| `app.stt.toggle` | (hold space) | ➖ | speech-to-text |

---

## Settings (`settings.ts`) & persistence

`omp --mode web` runs against the real `Settings` store (same instance as the
TUI), so a web write lands in the user's config files and the TUI sees it on next
read. **Status: ✅ done.** The gateway projects the SAME declarative catalog the
TUI menu uses (`settings-defs`/`settings-schema`) over `get-settings`, and
`set-setting` writes back through `Settings.set` (the shared store) with type
coercion + validation. The web `SettingsPanel` (`/settings`) renders the 10 tabs
with boolean/enum/submenu/text controls. Verified: boolean + enum round-trip live
and through a deterministic bridge test (`settings-bridge.test.ts`).

Runtime-injected option lists (themes via `options: "runtime"`) are now populated
over the wire: the gateway loads `getAvailableThemesWithPaths()` and feeds the
names into `buildWebSettings`, so the theme submenus list all themes and a pick
persists through `Settings.set` (verified live: dark theme → `amethyst` round-trips).

---

## Cross-cutting fixes already landed

- Slash commands execute (don't leak to model); unknown slash → model (correct).
- **One Enter runs the highlighted command** (Tab completes for arg-entry).
- Model dropdown shows **provider prefix**.
- shift+tab thinking · ctrl+p model · Esc abort · alt+m model picker.
- `command-output` surfaces as a toast.
- Dev serving rebuilds the SPA when source is stale.
- **`/model` picker overlay** (provider/name, fuzzy, current) + `/settings` panel.

## Remaining (➖ browser-N/A only — every command has a working web path)

1. ➖ items are platform-inherent: `/copy` (native selection), `/login`/`/logout`/`/setup`/`/providers` (CLI auth), `/debug` (terminal dev tool), `/exit`/`/quit` (close tab).
2. The `/btw`/`/omfg`/`/handoff` LLM side-calls return real content with a real model;
   they 401 (and report gracefully) only under the mock test harness.
