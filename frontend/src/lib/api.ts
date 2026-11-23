import { mockEvents, mockGraph } from './mock';
import { parseProofGraph } from './graph';
import { KIND_LABEL } from './format';
import type {
	AgentDoneEvent,
	AgentEvent,
	AssistantMessage,
	ChatMessage,
	HistoryResponse,
	HistoryTurn,
	LeanToolResult,
	LiveItem,
	ProofStep,
	ProofGraph,
	StepKind,
	ToolCall,
	User,
	UserMessage
} from './types';

/**
 * Backend base URL. Requests go to `${API_URL}/api/...`. Defaults to '' (same
 * origin), relying on the dev server's `/api` proxy (see vite.config.ts) or a
 * reverse proxy in production. Set `VITE_API_URL` only to point at a backend
 * on a different origin.
 */
const API_URL: string = import.meta.env.VITE_API_URL ?? '';

/** Set `VITE_MOCK=1` to use the built-in demo proof instead of the backend. */
export const isMockMode = import.meta.env.VITE_MOCK === '1';

let counter = 0;
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

// ---------------------------------------------------------------------------
// Errors

export type ApiErrorKind =
	| 'network' // fetch itself failed (offline, DNS, CORS, ...)
	| 'http' // a non-2xx response, before or instead of a stream
	| 'stream' // an in-band `{"type": "error"}` SSE event
	| 'protocol' // the stream ended without a `done` event
	| 'aborted'; // the caller's AbortSignal fired

export class ApiError extends Error {
	readonly kind: ApiErrorKind;
	readonly status?: number;

	constructor(kind: ApiErrorKind, message: string, status?: number) {
		super(message);
		this.name = 'ApiError';
		this.kind = kind;
		this.status = status;
	}
}

/**
 * Turn a parsed FastAPI error body into one readable string.
 *
 * `detail` is a string for most errors (e.g. 503s raised with `HTTPException`)
 * and an array of `{loc, msg, type}` objects for a 422 request-validation
 * error. `body` may also be `null` when the response wasn't JSON at all.
 */
export function describeErrorBody(body: unknown, status: number): string {
	if (body && typeof body === 'object' && 'detail' in body) {
		const detail = (body as { detail: unknown }).detail;
		if (typeof detail === 'string' && detail) return detail;
		if (Array.isArray(detail) && detail.length) {
			return detail
				.map((d) =>
					d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : JSON.stringify(d)
				)
				.join('; ');
		}
	}
	return `Request failed (${status})`;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
	let res: Response;
	try {
		res = await fetch(`${API_URL}${path}`, { ...init, credentials: 'include' });
	} catch (e) {
		if (init?.signal?.aborted) throw new ApiError('aborted', 'Request aborted');
		throw new ApiError('network', e instanceof Error ? e.message : String(e));
	}
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new ApiError('http', describeErrorBody(body, res.status), res.status);
	}
	if (res.status === 204) return undefined as T;
	return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Guest session
//
// `POST /api/session` validates the `ezlogic_guest` cookie or issues a new
// one; the frontend can't read it directly (HttpOnly). `ensureSession` makes
// sure exactly one such request is in flight at a time: `/api/chat` and
// `/api/history` also start a session on their own, so two concurrent first
// requests could otherwise each mint a different guest id and only one
// cookie would survive.

let sessionPromise: Promise<void> | null = null;

export function ensureSession(): Promise<void> {
	if (isMockMode) return Promise.resolve();
	if (!sessionPromise) {
		sessionPromise = fetchJson<void>('/api/session', { method: 'POST' }).catch((e: unknown) => {
			sessionPromise = null; // let the next call retry instead of caching the failure
			throw e;
		});
	}
	return sessionPromise;
}

/** Test-only: clears the remembered session check so the next test starts fresh. */
export function __resetSessionForTests(): void {
	sessionPromise = null;
	graphCache.clear();
}

const graphCache = new Map<string, ProofGraph>();

// ---------------------------------------------------------------------------
// Accounts (email + password). Optional: without one, the guest session above
// is used. The `ezlogic_user` cookie is HttpOnly, so `getMe` is how the UI
// learns who is signed in.

type AuthResponse = { user: User | null };

let mockUser: User | null = null;

/** Forget per-identity caches after the signed-in user changes. */
function identityChanged(): void {
	sessionPromise = null;
	graphCache.clear();
}

async function authenticate(path: string, email: string, password: string): Promise<User> {
	if (isMockMode) return (mockUser = { id: 'mock-user', email });
	const data = await fetchJson<AuthResponse>(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email, password })
	});
	if (!data.user) throw new ApiError('protocol', 'The server did not return a user');
	identityChanged();
	return data.user;
}

export const signup = (email: string, password: string) => authenticate('/api/auth/signup', email, password);
export const login = (email: string, password: string) => authenticate('/api/auth/login', email, password);

export async function logout(): Promise<void> {
	if (isMockMode) {
		mockUser = null;
		return;
	}
	await fetchJson<void>('/api/auth/logout', { method: 'POST' });
	identityChanged();
}

/** The signed-in user, or null for a guest. */
export async function getMe(signal?: AbortSignal): Promise<User | null> {
	if (isMockMode) return mockUser;
	const data = await fetchJson<AuthResponse>('/api/auth/me', { signal });
	return data.user ?? null;
}

/** Read the saved graph, or explicitly ask Lean to build a missing graph. */
export async function getProofGraph(queryId: string, signal?: AbortSignal, build = false): Promise<ProofGraph | null> {
	const checkAbort = () => { if (signal?.aborted) throw new ApiError('aborted', 'Request aborted'); };
	checkAbort();
	const cached = graphCache.get(queryId);
	if (cached && !build) return cached;
	let raw: unknown;
	if (isMockMode) {
		await sleep(350, signal);
		raw = mockGraph(queryId);
	} else {
		await ensureSession();
		checkAbort();
		raw = await fetchJson<unknown>(`/api/queries/${encodeURIComponent(queryId)}/graph`, {
			signal,
			method: build ? 'POST' : 'GET'
		});
	}
	checkAbort();
	if (raw === null) return null;
	let graph: ProofGraph;
	try { graph = parseProofGraph(raw, queryId); }
	catch (e) { throw new ApiError('protocol', e instanceof Error ? e.message : String(e)); }
	if (graphCache.size >= 50) graphCache.delete(graphCache.keys().next().value!);
	graphCache.set(queryId, graph);
	return graph;
}

// ---------------------------------------------------------------------------
// SSE parsing
//
// Kept separate from `fetch`/`ReadableStream` so it can be unit tested with
// plain strings, split at arbitrary points, without mocking the network.

function normalizeNewlines(s: string): string {
	return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Incrementally parses a `text/event-stream` body of `data: {json}` blocks
 * separated by blank lines (the shape `backend/main.py`'s `_sse()` writes).
 * Feed decoded text chunks to `push`; each call returns the events completed
 * by that chunk, in order. Call `flush` once after the stream ends to
 * recover a final block that wasn't followed by a trailing blank line.
 *
 * Multiple `data:` lines in one block are joined with `\n`, per the SSE
 * spec, though the backend never splits a single JSON event across lines.
 * Lines that aren't `data:` (comments, blank blocks) are ignored.
 */
export function createSSEParser<T = unknown>() {
	let buffer = '';

	function parseBlock(block: string): T | null {
		const lines = block.split('\n').filter((line) => line.startsWith('data:'));
		if (lines.length === 0) return null;
		const data = lines.map((line) => line.slice(5).replace(/^ /, '')).join('\n');
		return JSON.parse(data) as T;
	}

	function push(chunk: string): T[] {
		buffer = normalizeNewlines(buffer + chunk);
		const blocks = buffer.split(/\n\n+/);
		buffer = blocks.pop() ?? '';
		return blocks.map(parseBlock).filter((e): e is T => e !== null);
	}

	function flush(): T[] {
		const block = buffer;
		buffer = '';
		if (!block.trim()) return [];
		const parsed = parseBlock(block);
		return parsed !== null ? [parsed] : [];
	}

	return { push, flush };
}

// ---------------------------------------------------------------------------
// Chat

export function newChatId(): string {
	return crypto.randomUUID();
}

export interface StreamChatOptions {
	allowBuild?: boolean;
	model?: string;
	signal?: AbortSignal;
}

/** Resolves after `ms`, or rejects with an `aborted` `ApiError` as soon as `signal` fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new ApiError('aborted', 'Request aborted'));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(new ApiError('aborted', 'Request aborted'));
			},
			{ once: true }
		);
	});
}

/** Run one user turn. Yields each stream event in order; throws `ApiError` on any failure. */
export async function* streamChat(
	chatId: string,
	text: string,
	opts: StreamChatOptions = {}
): AsyncGenerator<AgentEvent> {
	if (isMockMode) {
		for (const { event, delay } of mockEvents(text)) {
			await sleep(delay, opts.signal);
			if (event.type === 'error') throw new ApiError('stream', event.detail);
			yield event;
		}
		return;
	}

	await ensureSession();

	let res: Response;
	try {
		res = await fetch(`${API_URL}/api/chat`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
			signal: opts.signal,
			body: JSON.stringify({
				chat_id: chatId,
				text,
				model: opts.model,
				allowBuild: opts.allowBuild ?? false
			})
		});
	} catch (e) {
		if (opts.signal?.aborted) throw new ApiError('aborted', 'Request aborted');
		throw new ApiError('network', e instanceof Error ? e.message : String(e));
	}

	const contentType = res.headers.get('content-type') ?? '';
	if (!res.ok || !contentType.includes('text/event-stream')) {
		if (!res.ok) {
			const body = await res.json().catch(() => null);
			throw new ApiError('http', describeErrorBody(body, res.status), res.status);
		}
		throw new ApiError('http', `Expected an event stream, got ${contentType || 'nothing'}`, res.status);
	}
	if (!res.body) throw new ApiError('protocol', 'Response has no body');

	const parser = createSSEParser<AgentEvent>();
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let sawDone = false;

	function check(ev: AgentEvent): AgentEvent {
		if (ev.type === 'error') throw new ApiError('stream', ev.detail);
		if (ev.type === 'done') sawDone = true;
		return ev;
	}

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (value) {
				// `{ stream: true }` keeps a multi-byte UTF-8 character that's split
				// across two chunks (common with Lean's ∀ ∃ ⊢ ∑ ...) from being
				// decoded as a stray replacement character.
				for (const ev of parser.push(decoder.decode(value, { stream: true }))) yield check(ev);
			}
			if (done) break;
		}
		for (const ev of parser.flush()) yield check(ev);
	} catch (e) {
		if (opts.signal?.aborted) throw new ApiError('aborted', 'Request aborted');
		if (e instanceof ApiError) throw e;
		throw new ApiError('network', e instanceof Error ? e.message : String(e));
	}

	if (!sawDone) {
		if (opts.signal?.aborted) throw new ApiError('aborted', 'Request aborted');
		throw new ApiError('protocol', 'Stream ended without a final event');
	}
}

export async function getHistory(chatId: string, signal?: AbortSignal): Promise<ChatMessage[]> {
	if (isMockMode) return [];
	await ensureSession();
	const data = await fetchJson<HistoryResponse>(`/api/history?chat_id=${encodeURIComponent(chatId)}`, {
		signal
	});
	return data.turns.flatMap(fromTurn);
}

// ---------------------------------------------------------------------------
// Live message updates (`token` / `tool_call_start` / `tool_result`)

export function emptyLiveMessage(id: string): AssistantMessage {
	return { id, role: 'assistant', status: 'unverified', steps: [], live: { state: 'streaming', items: [] } };
}

/**
 * Whether a tool's result counts as a failure.
 *
 * Checked in this order because `LeanResult.to_dict()` always includes an
 * `error` key, even on success (it's `null` then): `ok` is authoritative
 * whenever it's present. Only a tool result with no `ok` field at all (the
 * generic `{"error": "..."}` shape from `agent/tools.py`'s `run_tool`
 * except-block) falls back to checking for a truthy `error`.
 */
export function toolSucceeded(result: unknown): boolean {
	if (result && typeof result === 'object') {
		if ('ok' in result) return !!(result as LeanToolResult).ok;
		if ('error' in result) return !(result as { error: unknown }).error;
	}
	return true;
}

function toolTarget(args: Record<string, unknown>): string | undefined {
	return typeof args.path === 'string' ? args.path : undefined;
}

export function toolDiagnostic(result: unknown): string | undefined {
	if (!result || typeof result !== 'object') return undefined;
	const data = result as Record<string, unknown>;
	const parts: string[] = [];
	if (typeof data.error === 'string' && data.error) parts.push(data.error);
	if (Array.isArray(data.messages)) for (const raw of data.messages) {
		if (!raw || typeof raw !== 'object') continue;
		const msg = raw as Record<string, unknown>;
		if (msg.severity !== 'error' && msg.severity !== 'warning') continue;
		if (typeof msg.message !== 'string') continue;
		const location = typeof msg.line === 'number' ? `Line ${msg.line}: ` : '';
		parts.push(location + msg.message);
	}
	return parts.length ? parts.join('\n\n').slice(0, 12000) : undefined;
}

/** Index of the tool item a `tool_result` event belongs to, or -1 if there isn't one yet. */
function matchToolIndex(items: LiveItem[], id: string, name: string): number {
	if (id) {
		const i = items.findIndex((it) => it.kind === 'tool' && it.id === id);
		if (i !== -1) return i;
	}
	// Some backend tool calls don't carry an id when they're announced (see
	// frontend/README.md B6); match the oldest still-running call with the
	// same name instead.
	return items.findIndex((it) => it.kind === 'tool' && it.state === 'running' && it.name === name);
}

/**
 * Apply one streamed event to a message whose `live.state` is `'streaming'`.
 * A no-op once the draft has been stopped or errored, or once `done` has
 * already replaced it (no `live` at all): events can still be in flight when
 * the user clicks Stop, or after the stream itself reports an error.
 *
 * Consecutive `token`s merge into one text item; a token right after a tool
 * item starts a new one, so the timeline reads as alternating commentary and
 * tool steps in the order they actually happened.
 */
export function applyEvent(msg: AssistantMessage, ev: AgentEvent): AssistantMessage {
	if (!msg.live || msg.live.state !== 'streaming') return msg;
	const live = msg.live;

	if (ev.type === 'token') {
		const items = [...live.items];
		const last = items.at(-1);
		if (last?.kind === 'text') {
			items[items.length - 1] = { ...last, text: last.text + ev.content };
		} else {
			items.push({ kind: 'text', text: ev.content });
		}
		return { ...msg, live: { ...live, items } };
	}

	if (ev.type === 'tool_call_start') {
		return {
			...msg,
			live: { ...live, items: [...live.items, { kind: 'tool', id: ev.id, name: ev.name, state: 'running' }] }
		};
	}

	if (ev.type === 'tool_result') {
		const diagnostic = toolDiagnostic(ev.result);
		const probe = !!ev.result && typeof ev.result === 'object' && (ev.result as LeanToolResult).proof_candidate === false;
		const entry: LiveItem = {
			kind: 'tool',
			id: ev.id,
			name: ev.name,
			state: toolSucceeded(ev.result) ? 'ok' : 'failed',
			target: toolTarget(ev.arguments),
			...(probe && { probe }),
			...(diagnostic && { diagnostic })
		};
		const i = matchToolIndex(live.items, ev.id, ev.name);
		const items = i === -1 ? [...live.items, entry] : live.items.map((it, idx) => (idx === i ? entry : it));
		return { ...msg, live: { ...live, items } };
	}

	return msg;
}

/** Close a draft that was stopped by the user or hit a stream error, keeping whatever already arrived. A no-op if the message has no `live` draft (already finalized). */
export function endLive(
	msg: AssistantMessage,
	state: 'stopped' | 'error',
	errorDetail?: string
): AssistantMessage {
	if (!msg.live) return msg;
	return { ...msg, live: { ...msg.live, state, errorDetail } };
}

/**
 * Build the finished message once a `done` event arrives for a streaming
 * draft: `fromDone`'s result, but keeping the draft's id (so its card
 * doesn't jump) and folding its timeline into `trace` for the collapsed
 * "How this was checked" section.
 */
export function finalizeLive(draft: AssistantMessage, ev: AgentDoneEvent): AssistantMessage {
	const items = draft.live?.items ?? [];
	return { ...fromDone(ev), id: draft.id, trace: items.length > 0 ? items : undefined };
}

// ---------------------------------------------------------------------------
// Verification status, derived from the agent's own tool-call trace
//
// This is deliberately not based on anything the model says about itself
// (its prose, or a `"verified"` flag inside its own ```json block): a
// "Verified" badge must only ever reflect what a `check_lean_*` tool
// actually returned.

const LEAN_WRITE_TOOLS = new Set(['write_file', 'edit_file']);

/** The last `.lean` path touched by `write_file`, `edit_file` or `check_lean_file`, if any. */
export function extractLeanFile(toolCalls: ToolCall[]): string | undefined {
	for (let i = toolCalls.length - 1; i >= 0; i--) {
		const call = toolCalls[i];
		const path = call.arguments?.path;
		if (typeof path === 'string' && path.endsWith('.lean')) {
			if (LEAN_WRITE_TOOLS.has(call.name) || call.name === 'check_lean_file') return path;
		}
	}
	return undefined;
}

/**
 * True only if `leanFile`'s *last* `check_lean_file` call passed and nothing
 * wrote to the file afterwards; or, with no Lean file involved, if the last
 * `check_lean_snippet` call passed.
 */
export function deriveVerified(toolCalls: ToolCall[], leanFile: string | undefined): boolean {
	if (leanFile) {
		let lastWriteIndex = -1;
		let lastCheckIndex = -1;
		let lastCheckOk = false;
		toolCalls.forEach((call, i) => {
			if (call.arguments?.path !== leanFile) return;
			if (LEAN_WRITE_TOOLS.has(call.name)) {
				lastWriteIndex = i;
			} else if (call.name === 'check_lean_file') {
				lastCheckIndex = i;
				lastCheckOk = toolSucceeded(call.result);
			}
		});
		return lastCheckIndex !== -1 && lastCheckIndex > lastWriteIndex && lastCheckOk;
	}
	for (let i = toolCalls.length - 1; i >= 0; i--) {
		if (toolCalls[i].name === 'check_lean_snippet') return toolSucceeded(toolCalls[i].result);
	}
	return false;
}

export function deriveStatus(
	ev: Pick<AgentDoneEvent, 'finished' | 'verified' | 'tool_calls'>,
	leanFile: string | undefined
): AssistantMessage['status'] {
	if (!ev.finished) return 'failed';
	const verified = ev.verified ?? deriveVerified(ev.tool_calls, leanFile);
	return verified ? 'verified' : 'unverified';
}

// ---------------------------------------------------------------------------
// Turning agent replies into proof-step cards

/** Coerce loosely-typed JSON from the model into a valid ProofStep. */
function normaliseStep(raw: Partial<ProofStep>, i: number): ProofStep {
	const kind = (raw.kind && raw.kind in KIND_LABEL ? raw.kind : 'step') as StepKind;
	const lines = raw.leanLines;
	return {
		id: String(raw.id ?? `s${i + 1}`),
		kind,
		title: String(raw.title ?? ''),
		statementTex: String(raw.statementTex ?? ''),
		summary: String(raw.summary ?? ''),
		explanation: String(raw.explanation ?? raw.summary ?? ''),
		leanLines:
			Array.isArray(lines) && lines.length === 2 && lines.every(Number.isFinite)
				? [lines[0], lines[1]]
				: undefined
	};
}

/**
 * Turn the agent's prose reply into blocks.
 *
 * If the reply contains a ```json block of the shape
 * `{ "intro"?: string, "steps": ProofStep[], "lean"?: string }` it is used
 * directly. Otherwise the whole reply becomes one block, with the first
 * ```lean fence (if any) as its code.
 *
 * `status` here is only ever a placeholder (based on `finished`): callers
 * that have the agent's tool-call trace (`fromDone`, `fromTurn`) always
 * replace it with `deriveStatus`/a stored status instead of trusting
 * anything the model said about verification.
 */
export function fromReply(reply: string, finished = true): AssistantMessage {
	const id = uid('a');
	const status = finished ? 'unverified' : 'failed';

	const json = reply.match(/```json\s*([\s\S]*?)```/);
	if (json) {
		try {
			const parsed = JSON.parse(json[1]) as {
				intro?: string;
				steps: Partial<ProofStep>[];
				lean?: string;
			};
			if (Array.isArray(parsed.steps) && parsed.steps.length) {
				return {
					id,
					role: 'assistant',
					intro: parsed.intro,
					steps: parsed.steps.map(normaliseStep),
					lean: parsed.lean,
					status
				};
			}
		} catch {
			// fall through to the plain-text fallback
		}
	}

	const lean = reply.match(/```lean4?\s*([\s\S]*?)```/)?.[1]?.trimEnd();
	const prose = reply.replace(/```[\s\S]*?```/g, '').trim();
	const firstPara = prose.split(/\n\s*\n/)[0] ?? prose;
	return {
		id,
		role: 'assistant',
		lean,
		status,
		steps: [
			{
				id: 's1',
				kind: 'response',
				title: 'Response',
				statementTex: '',
				summary: firstPara,
				explanation: prose,
				leanLines: lean ? [1, lean.split('\n').length] : undefined
			}
		]
	};
}

/** Build the finished message once a `done` event arrives. */
export function fromDone(ev: AgentDoneEvent): AssistantMessage {
	const id = uid('a');
	const leanFile = ev.lean_file === null ? undefined : ev.lean_file ?? extractLeanFile(ev.tool_calls);
	const touchedLean = leanFile !== undefined || ev.tool_calls.some((c) => c.name === 'check_lean_snippet');
	const status = deriveStatus(ev, leanFile);

	// A cache hit's `reply` is the stored explanation (a ```json steps block)
	// when there is one, and otherwise duplicates `response` (older turns
	// stored before the explaining agent existed): `reply === response` means
	// "no explanation", for fresh and cached turns alike.
	const explanation = ev.reply !== ev.response ? ev.reply : '';
	const base = explanation ? fromReply(explanation, ev.finished) : null;

	const common = {
		id,
		leanFile,
		status,
		queryId: ev.query_id,
		cached: ev.cached,
		finished: ev.finished
	};

	if (base) {
		// A cache hit has no tool calls, but its `response` is always the stored Lean.
		return { ...base, ...common, lean: touchedLean || ev.cached ? ev.response || undefined : base.lean };
	}

	return {
		...common,
		role: 'assistant',
		lean: ev.response || undefined,
		steps: [
			{
				id: 's1',
				kind: 'response',
				title: ev.cached ? 'Cached result' : 'Lean proof',
				statementTex: '',
				summary: '',
				explanation: ev.cached
					? 'This answer was served from cache; no new explanation was generated for it.'
					: '',
				leanLines: ev.response ? [1, ev.response.split('\n').length] : undefined
			}
		]
	};
}

/** Turn one stored `GET /api/history` turn into its user/assistant message pair. */
export function fromTurn(turn: HistoryTurn): [UserMessage, AssistantMessage] {
	const user: UserMessage = { id: `u-${turn.query_id}`, role: 'user', text: turn.query };

	// History turns are always a cache hit by construction (they already
	// happened), so `status` can't be re-derived from a tool-call trace that
	// isn't stored; `unverified` is the same conservative choice `fromDone`
	// makes for a cache hit.
	const explanation = turn.reply && turn.reply !== turn.response ? turn.reply : '';
	const base = explanation ? fromReply(explanation) : null;
	const common = { queryId: turn.query_id, cached: true, finished: true, status: 'unverified' as const };

	const assistant: AssistantMessage = base
		? { ...base, id: `a-${turn.query_id}`, ...common, lean: turn.response }
		: {
				id: `a-${turn.query_id}`,
				role: 'assistant',
				...common,
				lean: turn.response,
				steps: [
					{
						id: 's1',
						kind: 'response',
						title: 'Lean proof',
						statementTex: '',
						summary: '',
						explanation: '',
						leanLines: [1, turn.response.split('\n').length]
					}
				]
			};
	return [user, assistant];
}
