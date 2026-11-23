/** What a proof step represents; drives the label shown on each card. */
export type StepKind =
	| 'theorem'
	| 'definition'
	| 'lemma'
	| 'strategy'
	| 'base-case'
	| 'inductive-step'
	| 'step'
	| 'conclusion'
	| 'response';

/**
 * One block of a proof, rendered as a grey card in the chat and as the
 * detail panel when expanded.
 *
 * Text fields may contain inline math as `$...$` and display math as `$$...$$`.
 */
export interface ProofStep {
	id: string;
	kind: StepKind;
	/** Short heading, e.g. "Base case". */
	title: string;
	/** The equation / theorem for this step, as LaTeX (no surrounding `$`). */
	statementTex: string;
	/** 2–3 line plain explanation shown on the card. */
	summary: string;
	/** Thorough explanation shown in the expanded panel. Paragraphs separated by blank lines. */
	explanation: string;
	/** 1-based inclusive line range of this step inside the message's `lean` source. */
	leanLines?: [number, number];
}

export type VerificationStatus = 'verified' | 'unverified' | 'failed';

/** Declaration dependencies extracted by Lean, independent of explanation steps. */
export interface ProofGraphNode {
	node_id: string;
	depends_on_ids: string[] | null;
	kind?: 'theorem' | 'technical' | null;
	proof_dependency_ids?: string[] | null;
	lean_name?: string;
	statement?: string;
	explanation?: string;
}

export interface ProofGraph {
	query_id: string;
	root_node_id: string;
	nodes: ProofGraphNode[];
}

export interface UserMessage {
	id: string;
	role: 'user';
	/** What the user typed (shown in the bubble). */
	text: string;
	/** Proof file attached to this message; its extracted text is sent to the agent. */
	attachment?: { name: string; size: number };
	/**
	 * The text actually sent to the agent, when it differs from `text` (an
	 * attachment's extracted content is appended to it). Resending on retry
	 * uses this, so a retried turn doesn't silently drop the attached file.
	 */
	prompt?: string;
}

/**
 * One item in the agent's timeline: a chunk of its own prose commentary, or
 * a tool call. Shown live while a message streams in (`AssistantMessage.live`)
 * and, collapsed, after it finishes (`AssistantMessage.trace`).
 */
export type LiveItem =
	| { kind: 'text'; text: string }
	| {
			kind: 'tool';
			id: string;
			name: string;
			/** Usually the file path the tool acted on, when there is one. */
			target?: string;
			/** Actual tool/compiler diagnostics, displayed as escaped plain text. */
			diagnostic?: string;
			/** Lean inspected or evaluated code without a proof declaration. */
			probe?: boolean;
			state: 'running' | 'ok' | 'failed';
	  };

/** The agent's progress on a message that hasn't finished cleanly yet. */
export interface LiveDraft {
	state: 'streaming' | 'stopped' | 'error';
	items: LiveItem[];
	/** Set when `state` is 'error'. */
	errorDetail?: string;
}

export interface AssistantMessage {
	id: string;
	role: 'assistant';
	/** Optional sentence shown above the proof blocks. */
	intro?: string;
	steps: ProofStep[];
	/** Full Lean source for the proof; each step points at a slice of it. */
	lean?: string;
	leanFile?: string;
	status: VerificationStatus;
	/** `queries.query_id` for this turn, or `null` if the turn wasn't saved (see AgentDoneEvent). */
	queryId?: string | null;
	/** True if this answer was served from the Postgres cache rather than a fresh agent run. */
	cached?: boolean;
	/** False if the agent hit AGENT_MAX_STEPS before finishing. */
	finished?: boolean;
	/** Present while streaming, and still present (read-only) if stopped or errored; absent once `done` arrives cleanly. */
	live?: LiveDraft;
	/**
	 * The agent's timeline, kept after a clean finish for the collapsed "How
	 * this was checked" section. Absent for a cache hit or a reloaded history
	 * turn: no trace is stored server-side (see frontend/README.md B10).
	 */
	trace?: LiveItem[];
}

export type ChatMessage = UserMessage | AssistantMessage;

export interface Chat {
	id: string;
	title: string;
	messages: ChatMessage[];
	updatedAt: number;
}

// ---------------------------------------------------------------------------
// Backend wire types: the shapes sent and received over HTTP/SSE. See
// database/README.md and backend/README.md for the authoritative contract.
//
// Fields marked "assumed" are not implemented by the backend yet (tracked in
// frontend/README.md as B1-B8). The frontend treats them as optional and
// falls back to deriving the same information itself when they're absent, so
// the UI doesn't regress when the field starts arriving.

export interface ChatRequest {
	chat_id: string;
	text: string;
	model?: string;
	allowBuild?: boolean;
}

/** `agent/lean.py`'s `LeanResult.to_dict()`: the result of a Lean check tool call. */
export interface LeanToolResult {
	ok: boolean;
	messages?: unknown[];
	output?: string;
	error?: string | null;
	proof_candidate?: boolean | null;
}

export interface ToolCall {
	name: string;
	arguments: Record<string, unknown>;
	result: unknown;
}

/** One `data: {...}` line of the `POST /api/chat` event stream. */
export type AgentEvent =
	| { type: 'token'; content: string }
	| { type: 'tool_call_start'; id: string; name: string }
	| ({ type: 'tool_result'; id: string } & ToolCall)
	| {
			type: 'done';
			cached: boolean;
			query_id: string | null;
			/** The Lean source produced by this turn (or the reply text, if no Lean tool ran). */
			response: string;
			/** The agent's prose explanation for this turn. */
			reply: string;
			finished: boolean;
			tool_calls: ToolCall[];
			/** Whether Lean accepted the final proof source. Optional on older and cached responses. */
			verified?: boolean;
			/** Path of the final proof file, or null when the response has no proof file. */
			lean_file?: string | null;
	  }
	| { type: 'error'; detail: string };

export type AgentDoneEvent = Extract<AgentEvent, { type: 'done' }>;

export interface HistoryTurn {
	query_id: string;
	model: string;
	query: string;
	response: string;
	created_at: string;
	/** The stored explanation (a ```json `{intro, steps}` block from the explaining agent), or null if none. */
	reply?: string | null;
}

export interface HistoryResponse {
	turns: HistoryTurn[];
}

/** Assumed backend addition (B1): `POST /api/session` returning more than 204. */
export interface SessionInfo {
	guest_id: string;
	expires_at: string;
	created: boolean;
}

/** A signed-in account (`/api/auth/*`). */
export interface User {
	id: string;
	email: string;
}
