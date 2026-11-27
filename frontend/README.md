# ezLogic Frontend

SvelteKit chat UI for the ezLogic Lean proof agent (see the root `README.md` for the full
project). Talks to the FastAPI backend in `../backend`.

## Proof file upload

On a new chat, a file field above the message box accepts a `.tex` or `.pdf` proof (up to 1 GB), optionally with typed instructions. The text is extracted in the browser (`src/lib/extract.ts`; PDFs via `pdfjs-dist`) and sent to `/api/chat` as part of `text`, so the backend is unchanged. `.tex` gives better results than `.pdf`, which loses math layout.

## Developing

Requires Node 22 (see `.nvmrc`; run `nvm use`).

```sh
npm install
npm run dev          # http://localhost:5173, proxies /api to the backend (see vite.config.ts)
```

By default `npm run dev` expects the backend on `http://localhost:8000` (see
`backend/README.md`). Override the proxy target with `API_PROXY_TARGET`, or set `VITE_MOCK=1`
(see `.env.example`) to run the UI against a built-in demo proof with no backend at all.

## Theme

The UI always opens in dark mode (the OS colour scheme is ignored). The sun/moon switch at the bottom left of the chat history toggles light mode; the choice isn't persisted, so a reload returns to dark. Colours are CSS tokens in `src/routes/layout.css`: dark is the base `:root`, light is `:root[data-theme='light']`, and `src/lib/theme.svelte.ts` sets that attribute.

## Testing

```sh
npm run check        # svelte-check (types)
npm run test          # vitest: src/lib/api.test.ts, src/lib/format.test.ts
```

`src/lib/api.ts` and `src/lib/format.ts` are unit tested because that's where most of the risk in
the frontend lives: turning an SSE stream that can arrive in arbitrary chunks into chat messages
and a live timeline, deciding what's safe to show while a ```json steps block is still being
written, and -- the most important one -- deciding whether a proof is shown as "Verified". That
decision must come only from what a Lean tool call actually returned, never from the model's own
say-so (its prose, or a `verified` flag inside its own ```json block). See the test names in
`api.test.ts`/`format.test.ts` for the specific cases covered (chunk splitting, UTF-8 boundaries,
error-body shapes, the verification-status truth table, and the live-view timeline/placeholder
logic).

Manual testing in mock mode (`VITE_MOCK=1`): sending `/slow` replays the demo proof with long,
visible delays between steps, to watch the live view (commentary, tool ticks, Stop). Sending
`/error` ends the run in a simulated stream error instead, to check the inline Retry.

## Building

```sh
npm run build
npm run preview       # serve the production build locally
```

`adapter-auto` is used for now; pick a real adapter before deploying (see
[the SvelteKit docs](https://svelte.dev/docs/kit/adapters)).

## Desktop app (Tauri)

The same frontend is packaged as a desktop app with [Tauri 2](https://v2.tauri.app) (`src-tauri/`).
It bundles the built site and connects to an ezLogic backend running elsewhere.

**Prerequisites:** a Rust toolchain. On Linux you also need the WebKitGTK 4.1 and libsoup3
development packages. See [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm run desktop:dev     # opens the app window on the Vite dev server (port 5173, hot reload)
npm run desktop:build   # release bundles in src-tauri/target/release/bundle/ (.deb, AppImage, ...)
VITE_MOCK=1 npm run desktop:dev   # UI only, no backend needed
```

**Which backend it uses:**
- If a URL has been saved from the **Server** button (bottom of the sidebar, or "Change server" on
  the connection-error banner), it uses that. The URL is stored in the app's localStorage.
- Otherwise it uses `VITE_API_URL` from build time.
- Otherwise it uses `http://localhost:8000`.

The Server dialog's **Test** button calls the backend's `GET /health`.

**How requests work:** in the app, `src/lib/api.ts` sends backend calls through
`@tauri-apps/plugin-http` instead of the webview's `fetch`. The plugin is a Rust-side HTTP
client with its own cookie jar. Because the page runs on `tauri://localhost`, the webview would hit
CORS and cross-site cookie rules, and the plugin avoids both. So the backend's HttpOnly session
cookies and the SSE chat stream work with no backend changes.

The jar is saved to a `.cookies` file in the app's data directory on exit, so sign-ins survive a
restart. `src-tauri/capabilities/default.json` lists the URLs the plugin may call. The list is broad
on purpose, since the server URL can be changed at runtime.

## Declaration dependency graph

Each completed response has a **View dependency graph** button. It opens a graph
panel beside the conversation (full-screen on small screens). An arrow `A → B`
means **A depends on B**. Select a declaration to see its formal statement,
direct dependencies, and incoming references. The declaration dropdown provides
keyboard navigation. Use the graph controls for zoom/fit, and Close or Escape to
return to the conversation.

The graph is a read-only view of Lean-extracted declarations, not the explanation
agent's step cards. Opening it never calls the model or changes verification status.
Svelte Flow renders the graph and Dagre arranges it. The default view shows the
root and the theorems or lemmas it uses directly. Select a node to expand its
branch. **Technical details** shows the underlying Lean declarations. At the
extraction limit, a node has `null` dependencies and cannot be expanded further.

`getProofGraph` calls `GET /api/queries/{query_id}/graph` using the existing guest
cookie. It validates the response, caches successful snapshots in memory, and
cancels or ignores stale requests when the user switches proofs. A `null` result
means this guest owns the proof and its graph is missing. A 404 tells the user
the proof is unavailable in the current session. **Build dependency graph** asks Lean to extract a graph from
the saved source without running the writer. **Update graph** upgrades a graph
created before Lean supplied theorem and lemma classifications. Unsaved responses
have no query ID.

The endpoint returns `{query_id, root_node_id, nodes}`; each node has `node_id`
and `depends_on_ids`, with optional `lean_name`, `statement`, and `explanation`.
Node IDs are scoped to the query. Metadata-free graphs display the IDs directly.
All dependency targets must be present, even when their own dependencies are null.

For a frontend-only demo in PowerShell:

```powershell
$env:VITE_MOCK = '1'
npm.cmd run dev
```

The existing demo proof includes the illustrative A/B/C/D graph. Send `/graph shared`,
`/graph single`, `/graph partial`, `/graph cycle`, `/graph invalid`, `/graph missing`,
or `/graph error` to exercise other fixtures, then open that response's graph.
Mock graphs are explicitly labeled as illustrative, not extracted from the demo proof.
Unset `VITE_MOCK` and restart the dev server to use the backend again.

Graph tests live in `src/lib/graph.test.ts` and `src/lib/api.test.ts`; run them with
the normal `npm run test` command. See [implementation_plan.md](implementation_plan.md)
for the implementation breakdown and remaining manual browser checks.

## Backend contract

The frontend's `src/lib/types.ts` ("Backend wire types" section) and `src/lib/api.ts` mirror the
backend's actual HTTP/SSE contract, documented in `../database/README.md` and
`../backend/README.md`. Some fields the frontend uses aren't implemented by the backend yet; they
are marked `// assumed backend addition (B#)` in the code and are optional in the types, with the
frontend deriving the same information itself (from the agent's tool-call trace) when the field
is absent. Backend changes should either implement these or let this list be updated instead.

| # | Assumption | Frontend fallback until it exists |
| --- | --- | --- |
| B1 | `POST /api/session` returns `200 {guest_id, expires_at, created}` instead of `204` | Can't tell a known guest from a new one; a chat list (future work) would need to detect an empty history instead |
| B4 | The agent's prose explanation (`reply`) is stored, so a cache hit's `reply` is the real explanation, and `GET /api/history` turns include it too | When `reply` is missing or equals `response` (true for every cache hit today, since `reply` just duplicates the Lean source), the UI shows a generic "Cached result" / "Lean proof" card with no explanation |
| B5 | The agent's final reply contains a &#96;&#96;&#96;json &#123;steps, intro?, lean?&#125; block (shape in `fromReply`) | A single "Response" step built from the whole reply, with the first &#96;&#96;&#96;lean&#96;&#96;&#96; fence (if any) as its code |
| B6 | `tool_call_start.id` is never empty | Matched to its `tool_result` by order instead (oldest still-running call with the same name) |
| B7 | The backend agent run stops promptly when the client disconnects (the Stop button aborts the fetch) | None needed client-side; the backend just keeps running unseen until it finishes or errors on its own |
| B8 | A "list my chats" endpoint | The chat list lives in `localStorage` (not yet implemented) |
| B9 | Each run gets its own workspace directory | The UI only allows one run at a time, across every chat (`+page.svelte`'s `inFlight`): `main.py` currently gives every request the same shared `Workspace`, so two concurrent runs could overwrite each other's `.lean` files and invalidate each other's verification result |
| B10 | The agent's tool-call trace is stored per turn and returned by `GET /api/history` | The collapsed "How this was checked" section (`AgentTrace.svelte`) only has anything to show right after a live run finishes (`AssistantMessage.trace`, filled in by `finalizeLive`); it's hidden for a cache hit or a reloaded history turn, since no trace is stored for those |

Everything else in `AgentEvent`/`ChatRequest`/`HistoryTurn` (`types.ts`) is already how the
backend behaves as of the `agentStreaming` branch merge.
