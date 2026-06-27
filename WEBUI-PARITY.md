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
| `/drop` | TUI-only | ❌ | delete current + start new — control op + confirm |
| `/resume` | TUI-only | ✅ | session picker (list-sessions + switch-session); switch re-snapshots the transcript |
| `/tree` | TUI-only | ❌ | session-tree nav overlay (branches) |
| `/branch` | TUI-only | ✅ | "⎇ branch" button on each user message → branch(entryId) + re-snapshot |
| `/fork` | TUI-only | ✅ | session.fork() (history copied) + re-snapshot |
| `/handoff` | TUI-only | ❌ | handoff context to new session |
| `/session` | both | 🟡 | `info`/`delete` run as text; fine |
| `/rename` | both | 🟡 | runs (text); could inline-edit header title |
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
| `/plan-review` | TUI-only | ❌ | reopen latest plan review — overlay |
| `/goal` | TUI-only | 🟡 | goal status+objective shown in the mode bar; mutation (set/pause/resume) deferred (TUI controller has no clean API) |
| `/guided-goal` | TUI-only | ❌ | goal interview — multi-step dialog; defer |
| `/loop` | TUI-only | ❌ | loop driven by the TUI run loop — needs a client-side loop; deferred |
| `/btw` | TUI-only | ❌ | ephemeral side question — deferred (branch flow) |
| `/tan` | TUI-only | ❌ | background tangential agent — deferred |
| `/omfg` | TUI-only | ❌ | forge TTSR rule from complaint — dialog |
| `/retry` | TUI-only | ✅ | routed to session.retry() (also alt+r) |
| `/force` | both | 🟡 | runs; needs tool arg (no selector yet) |

### Context & transcript
| cmd | kind | web | notes / plan |
|---|---|---|---|
| `/context` | both | 🟡 | runs (text); TUI shows a breakdown panel |
| `/compact` | both | ✅ | `soft`/`remote`/`snapcompact` run |
| `/shake` | both | ✅ | `elide`/`images` run |
| `/fresh` | both | ✅ | runs |
| `/tools` | both | 🟡 | runs (text); ctrl+o expand has no web equiv |
| `/todo` | both | 🟡 | runs (text); TUI has an editor + the todo HUD |
| `/dump` | both | 🟡 | TUI copies to clipboard — web should copy in-browser |
| `/export` | both | 🟡 | writes HTML server-side — web should offer a download |
| `/copy` | TUI-only | ❌ | pick text/code to copy — selection overlay |
| `/memory` | both | ✅ | many subs; run as text |

### Providers, MCP, plugins, infra
| cmd | kind | web | notes / plan |
|---|---|---|---|
| `/setup` `/providers` | TUI-only | ❌ | provider setup wizard — onboarding dialog; defer |
| `/login` `/logout` | TUI-only | ❌/➖ | OAuth device flow — needs web auth surface |
| `/mcp` | both | ✅ | full sub-tree runs (text); MCP badge shows status |
| `/ssh` | both | ✅ | `add`/`list`/`remove` run |
| `/marketplace` | both | ✅ | runs (text) |
| `/plugins` | both | ✅ | `list`/`enable`/`disable` run |
| `/reload-plugins` | both | ✅ | runs |
| `/extensions` | TUI-only | ❌ | Extension Control Center — panel |
| `/agents` | TUI-only | 🟡 | Agent Control Center — `AgentsPanel`/drawer exists, not full parity |

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
| `/stats` | text | 🟡 | launches local stats dashboard — web could link out |
| `/debug` | TUI-only | ❌ | debug tools selector — overlay |
| `/hotkeys` | TUI-only | ✅ | keyboard + command reference overlay (Esc closes) |
| `/settings` | TUI-only | ✅ | settings panel (read+write) over `get-settings`/`set-setting`, persists to the shared store |

**Tally:** ✅ ~24 · 🟡 ~12 · ⛔/❌ ~20 · ➖ ~6. The "both" commands already run
(text); the gap is (a) TUI-only selectors/dashboards and (b) richer surfaces for
commands that today only echo text.

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
| `app.message.dequeue` | alt+up | ❌ | dequeue queued message |
| `app.agents.hub` | alt+a | 🟡 | agent drawer exists |
| `app.plan.toggle` | alt+shift+p | 🟡 | `/plan` toggles it; alt+shift+p chord not yet bound |
| `app.history.search` | ctrl+r | ❌ | search input history |
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

_Gap:_ runtime-injected option lists (themes via `options: "runtime"`) arrive
empty over the wire — the theme submenu shows only the current value. Needs a
runtime option source (follow-up).

---

## Cross-cutting fixes already landed

- Slash commands execute (don't leak to model); unknown slash → model (correct).
- **One Enter runs the highlighted command** (Tab completes for arg-entry).
- Model dropdown shows **provider prefix**.
- shift+tab thinking · ctrl+p model · Esc abort · alt+m model picker.
- `command-output` surfaces as a toast.
- Dev serving rebuilds the SPA when source is stale.
- **`/model` picker overlay** (provider/name, fuzzy, current) + `/settings` panel.

## Next up (priority order)

1. Session overlays building on re-snapshot: `/tree`, `/branch`/`/fork` (transcript message picker).
2. Richer surfaces: `/context` breakdown, `/todo` editor, `/dump`/`/export` browser copy/download.
3. Goal-mode mutation control ops (`/goal set/pause/resume/drop/budget`).
4. `/loop` (client-side loop), `/btw`, `/tan`, `/guided-goal`, `/omfg` flows.
5. Theme runtime options over the wire (settings panel gap).
