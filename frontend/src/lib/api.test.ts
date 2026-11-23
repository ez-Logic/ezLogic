import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ApiError,
	__resetSessionForTests,
	applyEvent,
	createSSEParser,
	deriveStatus,
	deriveVerified,
	describeErrorBody,
	emptyLiveMessage,
	endLive,
	ensureSession,
	extractLeanFile,
	finalizeLive,
	fromDone,
	fromReply,
	fromTurn,
	getHistory,
	getMe,
	getProofGraph,
	login,
	logout,
	signup,
	streamChat,
	toolSucceeded,
	toolDiagnostic
} from './api';
import { mockGraph } from './mock';
import type { AgentDoneEvent, AgentEvent, HistoryTurn, ToolCall } from './types';

// ---------------------------------------------------------------------------
// Test helpers

/** Encode a sequence of SSE events the way backend/main.py's `_sse()` does. */
function encodeSSE(events: unknown[]): string {
	return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

/** Split `s` into `n` pieces at arbitrary (not necessarily even) byte-ish offsets. */
function splitInto(s: string, n: number): string[] {
	if (n <= 1) return [s];
	const parts: string[] = [];
	let rest = s;
	for (let i = 0; i < n - 1; i++) {
		const cut = Math.floor(rest.length / 2);
		parts.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	parts.push(rest);
	return parts;
}

/** Every split of `s` at every single offset from 0 to s.length. */
function everySplit(s: string): [string, string][] {
	const out: [string, string][] = [];
	for (let i = 0; i <= s.length; i++) out.push([s.slice(0, i), s.slice(i)]);
	return out;
}

function streamResponse(body: string, opts: { contentType?: string; status?: number } = {}): Response {
	return new Response(body, {
		status: opts.status ?? 200,
		headers: { 'Content-Type': opts.contentType ?? 'text/event-stream' }
	});
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

beforeEach(() => {
	__resetSessionForTests();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('tool diagnostics', () => {
	it('retains a successful evaluation as a diagnostic, with no proof attached', () => {
		const call = { name: 'check_lean_snippet', arguments: { code: '#eval Nat.factorization 6' }, result: { ok: true, proof_candidate: false } };
		const draft = applyEvent(emptyLiveMessage('draft'), { type: 'tool_result', id: 'eval', ...call });
		const response = finalizeLive(draft, {
			type: 'done', cached: false, query_id: null, response: '',
			reply: 'The writer stopped before submitting a Lean proof.', finished: false, verified: false,
			tool_calls: [call], lean_file: null
		});
		expect(response.status).toBe('failed');
		expect(response.lean).toBeUndefined();
		expect(response.trace?.[0]).toMatchObject({ kind: 'tool', probe: true, state: 'ok' });
	});

	it('retains compiler errors through the final live trace', () => {
		const result = { ok: false, messages: [{ severity: 'error', line: 5, message: 'Unknown identifier `obtain`' }] };
		expect(toolDiagnostic(result)).toBe('Line 5: Unknown identifier `obtain`');
		const draft = applyEvent(emptyLiveMessage('draft'), { type: 'tool_result', id: 'check', name: 'check_lean_file', arguments: { path: 'proof.lean' }, result });
		const final = finalizeLive(draft, { type: 'done', cached: false, query_id: null, response: '', reply: 'Stopped', finished: false, tool_calls: [] });
		expect(final.trace?.[0]).toMatchObject({ state: 'failed', diagnostic: 'Line 5: Unknown identifier `obtain`' });
	});
	it('handles tooling failures and ignores info messages and malformed diagnostics', () => {
		expect(toolDiagnostic({ error: 'MemoryError: unavailable' })).toContain('MemoryError');
		expect(toolDiagnostic({ ok: true, messages: [{ severity: 'info', message: 'Nat : Type' }, null] })).toBeUndefined();
	});
});

describe('saved proof graphs', () => {
	it('can rebuild an absent graph and cache the recovered result', async () => {
		const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(jsonResponse(null))
			.mockResolvedValueOnce(jsonResponse(mockGraph('q1')));
		vi.stubGlobal('fetch', fetcher);
		expect(await getProofGraph('q1')).toBeNull();
		const graph = await getProofGraph('q1', undefined, true);
		expect(graph?.query_id).toBe('q1');
		expect(fetcher.mock.calls[1][1].method).toBe('GET');
		expect(fetcher.mock.calls[2][1]).toMatchObject({ method: 'POST', credentials: 'include' });
		expect(await getProofGraph('q1')).toBe(graph);
	});

	it('includes the guest cookie, uses the query endpoint, and caches successful responses', async () => {
		const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(jsonResponse(mockGraph('q1')));
		vi.stubGlobal('fetch', fetcher);
		const graph = await getProofGraph('q1');
		expect(graph?.query_id).toBe('q1');
		expect(fetcher.mock.calls[1][0]).toBe('/api/queries/q1/graph');
		expect(fetcher.mock.calls[1][1].credentials).toBe('include');
		await getProofGraph('q1');
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it('does not cache absent graphs and reports retryable server errors', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(jsonResponse(null))
			.mockResolvedValueOnce(jsonResponse({ detail: 'Database unavailable' }, 503)));
		expect(await getProofGraph('q1')).toBeNull();
		await expect(getProofGraph('q1')).rejects.toMatchObject({ status: 503 });
	});

	it('surfaces a saved proof that the current guest cannot access', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(jsonResponse({ detail: 'This saved proof is unavailable in your guest session.' }, 404)));
		await expect(getProofGraph('q1')).rejects.toMatchObject({ status: 404, message: expect.stringContaining('guest session') });
	});
	it('rejects malformed data and honors an already aborted request', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(jsonResponse(mockGraph('other'))));
		await expect(getProofGraph('q1')).rejects.toMatchObject({ kind: 'protocol' });
		const controller = new AbortController(); controller.abort();
		await expect(getProofGraph('q1', controller.signal)).rejects.toMatchObject({ kind: 'aborted' });
	});
});

// ---------------------------------------------------------------------------
// 6.1 createSSEParser: the stream arrives in arbitrary pieces

describe('createSSEParser', () => {
	const events = [
		{ type: 'token', content: 'hello' },
		{ type: 'tool_call_start', id: 't1', name: 'check_lean_file' },
		{ type: 'done', cached: false, query_id: 'q1', response: 'ok', reply: 'ok', finished: true, tool_calls: [] }
	];
	const wire = encodeSSE(events);

	it('parses a single push with no splitting', () => {
		const p = createSSEParser();
		expect(p.push(wire)).toEqual(events);
		expect(p.flush()).toEqual([]);
	});

	it('parses the same events no matter where the stream is split in two', () => {
		for (const [a, b] of everySplit(wire)) {
			const p = createSSEParser();
			const got = [...p.push(a), ...p.push(b), ...p.flush()];
			expect(got, `split at ${a.length}`).toEqual(events);
		}
	});

	it('parses the same events split into many small, uneven chunks', () => {
		for (const n of [2, 3, 5, 7, 13]) {
			const p = createSSEParser();
			const got = splitInto(wire, n).flatMap((chunk) => p.push(chunk));
			expect([...got, ...p.flush()], `split into ${n}`).toEqual(events);
		}
	});

	it('parses several events delivered in one chunk', () => {
		const p = createSSEParser();
		expect(p.push(wire)).toEqual(events);
	});

	it('handles CRLF line endings', () => {
		const crlf = wire.replace(/\n/g, '\r\n');
		const p = createSSEParser();
		expect(p.push(crlf)).toEqual(events);
	});

	it('recovers a final event with no trailing blank line via flush', () => {
		const withoutTrailer = wire.replace(/\n\n$/, '');
		const p = createSSEParser();
		const fromPush = p.push(withoutTrailer);
		const fromFlush = p.flush();
		expect([...fromPush, ...fromFlush]).toEqual(events);
		expect(fromFlush.length).toBeGreaterThan(0);
	});

	it('ignores comment lines and empty blocks', () => {
		const p = createSSEParser();
		const got = p.push(`: keep-alive\n\ndata: ${JSON.stringify(events[0])}\n\n\n\n`);
		expect(got).toEqual([events[0]]);
	});

	it('keeps a multi-byte character intact when split across chunks', () => {
		// "∑" (U+2211) is 3 UTF-8 bytes; splitting the *decoded* JS string at
		// any index is always a valid UTF-16 boundary, so this exercises the
		// SSE block splitter rather than UTF-8 decoding (that's streamChat's
		// job, covered separately below) -- but it still must not corrupt or
		// drop the character while buffering an incomplete block.
		const ev = { type: 'token', content: '∑ i ∈ range (n + 1)' };
		const w = encodeSSE([ev]);
		for (const [a, b] of everySplit(w)) {
			const p = createSSEParser();
			expect([...p.push(a), ...p.push(b), ...p.flush()], `split at ${a.length}`).toEqual([ev]);
		}
	});
});

// ---------------------------------------------------------------------------
// UTF-8 decoding boundary (the byte-level half of multi-byte safety)

describe('UTF-8 decoding across chunk boundaries', () => {
	it('TextDecoder with {stream: true} reassembles a character split mid-sequence', () => {
		const bytes = new TextEncoder().encode('∑');
		expect(bytes.length).toBe(3);
		const decoder = new TextDecoder();
		const a = decoder.decode(bytes.slice(0, 1), { stream: true });
		const b = decoder.decode(bytes.slice(1), { stream: true });
		expect(a).toBe(''); // incomplete sequence: buffered, not emitted as U+FFFD
		expect(b).toBe('∑');
	});

	it('without {stream: true}, a split sequence is corrupted (justifies passing it)', () => {
		const bytes = new TextEncoder().encode('∑');
		const decoder = new TextDecoder();
		const a = decoder.decode(bytes.slice(0, 1));
		expect(a).toBe('\uFFFD'); // replacement character: this is the bug {stream: true} avoids
	});
});

// ---------------------------------------------------------------------------
// describeErrorBody

describe('describeErrorBody', () => {
	it('uses a string detail (e.g. a 503)', () => {
		expect(describeErrorBody({ detail: 'ANTHROPIC_API_KEY is not set' }, 503)).toBe(
			'ANTHROPIC_API_KEY is not set'
		);
	});

	it('flattens a 422 array detail into one readable string', () => {
		const body = {
			detail: [
				{ loc: ['body', 'chat_id'], msg: 'Input should be a valid UUID', type: 'uuid_parsing' },
				{ loc: ['body', 'text'], msg: 'Field required', type: 'missing' }
			]
		};
		expect(describeErrorBody(body, 422)).toBe('Input should be a valid UUID; Field required');
	});

	it('falls back to a generic message when the body has no usable detail', () => {
		expect(describeErrorBody(null, 500)).toBe('Request failed (500)');
		expect(describeErrorBody({}, 500)).toBe('Request failed (500)');
		expect(describeErrorBody({ detail: [] }, 422)).toBe('Request failed (422)');
	});
});

// ---------------------------------------------------------------------------
// 6.3 ensureSession: a single session check

describe('ensureSession', () => {
	it('makes exactly one request for several concurrent callers', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal('fetch', fetchMock);

		await Promise.all([ensureSession(), ensureSession(), ensureSession()]);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toContain('/api/session');
		expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'include' });
	});

	it('does not re-fetch on a later call once a check has succeeded', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal('fetch', fetchMock);

		await ensureSession();
		await ensureSession();

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('lets the next call retry after a failed check, instead of caching the failure', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response('{"detail": "db down"}', { status: 503 }))
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(ensureSession()).rejects.toThrow(ApiError);
		await expect(ensureSession()).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('getHistory waits for the session check before fetching history', async () => {
		const calls: string[] = [];
		const fetchMock = vi.fn().mockImplementation(async (url: string) => {
			calls.push(url);
			if (url.includes('/api/session')) return new Response(null, { status: 204 });
			return jsonResponse({ turns: [] });
		});
		vi.stubGlobal('fetch', fetchMock);

		await getHistory('11111111-1111-1111-1111-111111111111');

		expect(calls[0]).toContain('/api/session');
		expect(calls[1]).toContain('/api/history');
	});
});

// ---------------------------------------------------------------------------
// 6.2 streamChat: ending cleanly and classifying errors

describe('streamChat', () => {
	beforeEach(() => {
		// Every streamChat test supplies its own /api/chat response; stub the
		// session check once so it's not the thing under test here.
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation(async (url: string) => {
				if (url.includes('/api/session')) return new Response(null, { status: 204 });
				throw new Error('unexpected fetch in this test');
			})
		);
	});

	async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
		const out: AgentEvent[] = [];
		for await (const ev of gen) out.push(ev);
		return out;
	}

	function mockChatFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
		const fetchMock = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
			if (url.includes('/api/session')) return new Response(null, { status: 204 });
			return handler(url, init);
		});
		vi.stubGlobal('fetch', fetchMock);
		return fetchMock;
	}

	it('yields every event and resolves once `done` arrives', async () => {
		const events = [
			{ type: 'token', content: 'thinking' },
			{
				type: 'done',
				cached: false,
				query_id: 'q1',
				response: 'theorem t : True := trivial',
				reply: 'Here you go.',
				finished: true,
				tool_calls: []
			}
		];
		mockChatFetch(() => streamResponse(encodeSSE(events)));

		const got = await collect(streamChat('c1', 'prove True'));
		expect(got).toEqual(events);
	});

	it('a 503 with a string detail becomes an http ApiError with that text', async () => {
		mockChatFetch(() => jsonResponse({ detail: 'ANTHROPIC_API_KEY is not set' }, 503));

		const err = await collect(streamChat('c1', 'x')).catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.kind).toBe('http');
		expect(err.status).toBe(503);
		expect(err.message).toBe('ANTHROPIC_API_KEY is not set');
	});

	it('a 422 with an array detail is flattened into readable text', async () => {
		mockChatFetch(() =>
			jsonResponse({ detail: [{ loc: ['body', 'text'], msg: 'Field required', type: 'missing' }] }, 422)
		);

		const err = await collect(streamChat('c1', 'x')).catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.kind).toBe('http');
		expect(err.message).toBe('Field required');
	});

	it('a stream that ends without `done` is a protocol error', async () => {
		mockChatFetch(() => streamResponse(encodeSSE([{ type: 'token', content: 'still going' }])));

		const err = await collect(streamChat('c1', 'x')).catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.kind).toBe('protocol');
	});

	it('an in-stream error event becomes a stream ApiError', async () => {
		mockChatFetch(() =>
			streamResponse(encodeSSE([{ type: 'token', content: 'partial' }, { type: 'error', detail: 'boom' }]))
		);

		const err = await collect(streamChat('c1', 'x')).catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.kind).toBe('stream');
		expect(err.message).toBe('boom');
	});

	it('a 200 response that is not an event stream is an http error', async () => {
		mockChatFetch(() => jsonResponse({ oops: true }, 200));

		const err = await collect(streamChat('c1', 'x')).catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.kind).toBe('http');
	});

	it('aborting the request surfaces as an aborted ApiError, not a network error', async () => {
		const controller = new AbortController();
		mockChatFetch((_url, init) => {
			if ((init.signal as AbortSignal)?.aborted) {
				return Promise.reject(new DOMException('aborted', 'AbortError'));
			}
			return Promise.reject(new DOMException('aborted', 'AbortError'));
		});
		controller.abort();

		const err = await collect(streamChat('c1', 'x', { signal: controller.signal })).catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.kind).toBe('aborted');
	});
});

// ---------------------------------------------------------------------------
// 6.4 Verification status: the "Verified" badge must only reflect Lean's own say-so

describe('extractLeanFile / deriveVerified / deriveStatus', () => {
	const call = (name: string, args: Record<string, unknown>, result: unknown): ToolCall => ({
		name,
		arguments: args,
		result
	});
	const ok = { ok: true, messages: [], output: '', error: null };
	const fail = { ok: false, messages: [], output: 'error: unknown identifier', error: null };

	it('a passing file check is verified', () => {
		const calls = [
			call('write_file', { path: 'P.lean' }, { result: 'ok' }),
			call('check_lean_file', { path: 'P.lean' }, ok)
		];
		const file = extractLeanFile(calls);
		expect(file).toBe('P.lean');
		expect(deriveVerified(calls, file)).toBe(true);
	});

	it('a failed check, fixed and re-checked successfully, is verified (the last check wins)', () => {
		const calls = [
			call('write_file', { path: 'P.lean' }, { result: 'ok' }),
			call('check_lean_file', { path: 'P.lean' }, fail),
			call('edit_file', { path: 'P.lean' }, { result: 'ok' }),
			call('check_lean_file', { path: 'P.lean' }, ok)
		];
		const file = extractLeanFile(calls);
		expect(deriveVerified(calls, file)).toBe(true);
	});

	it('a passing check followed by an unchecked edit is unverified', () => {
		const calls = [
			call('write_file', { path: 'P.lean' }, { result: 'ok' }),
			call('check_lean_file', { path: 'P.lean' }, ok),
			call('edit_file', { path: 'P.lean' }, { result: 'ok' })
		];
		const file = extractLeanFile(calls);
		expect(deriveVerified(calls, file)).toBe(false);
	});

	it('a passing snippet check does not offset a failed file check', () => {
		const calls = [
			call('check_lean_snippet', { code: 'example : True := trivial' }, ok),
			call('write_file', { path: 'P.lean' }, { result: 'ok' }),
			call('check_lean_file', { path: 'P.lean' }, fail)
		];
		const file = extractLeanFile(calls);
		expect(deriveVerified(calls, file)).toBe(false);
	});

	it('falls back to the last snippet check when no Lean file was ever touched', () => {
		const calls = [
			call('check_lean_snippet', { code: 'bad' }, fail),
			call('check_lean_snippet', { code: 'example : True := trivial' }, ok)
		];
		expect(extractLeanFile(calls)).toBeUndefined();
		expect(deriveVerified(calls, undefined)).toBe(true);
	});

	it('a tool reporting "Lean not installed" ({error: ...}) is not verified', () => {
		const calls = [call('check_lean_snippet', { code: 'x' }, { error: 'Lean is not installed' })];
		expect(deriveVerified(calls, undefined)).toBe(false);
	});

	it('deriveStatus is "failed" when the agent did not finish, even with a passing check', () => {
		const calls = [call('check_lean_file', { path: 'P.lean' }, ok)];
		expect(deriveStatus({ finished: false, tool_calls: calls }, 'P.lean')).toBe('failed');
	});

	it('deriveStatus is "unverified" for a cache hit with no tool calls', () => {
		expect(deriveStatus({ finished: true, tool_calls: [] }, undefined)).toBe('unverified');
	});

	it('deriveStatus trusts an explicit `verified` field over the derived value', () => {
		const calls = [call('check_lean_file', { path: 'P.lean' }, fail)];
		expect(deriveStatus({ finished: true, verified: true, tool_calls: calls }, 'P.lean')).toBe('verified');
	});
});

// ---------------------------------------------------------------------------
// 6.5 Conversion functions: the right content in the right place

describe('fromDone', () => {
	const base = {
		type: 'done' as const,
		cached: false,
		query_id: 'q1',
		finished: true,
		tool_calls: [] as ToolCall[]
	};

	it('shows the compiled Lean file, not a code fence quoted in the prose, when Lean was touched', () => {
		const ev: AgentDoneEvent = {
			...base,
			response: 'theorem real : True := trivial -- the actual compiled file',
			reply: 'I wrote ```lean\ntheorem real : stale snippet\n``` and checked it.',
			tool_calls: [
				{ name: 'write_file', arguments: { path: 'P.lean' }, result: {} },
				{
					name: 'check_lean_file',
					arguments: { path: 'P.lean' },
					result: { ok: true, messages: [], output: '', error: null }
				}
			]
		};
		const msg = fromDone(ev);
		expect(msg.lean).toBe(ev.response);
		expect(msg.leanFile).toBe('P.lean');
		expect(msg.status).toBe('verified');
	});

	it('has no lean field when no Lean tool ran and the reply has no code fence', () => {
		const ev: AgentDoneEvent = { ...base, response: 'No Lean needed.', reply: 'This statement is trivially true.' };
		const msg = fromDone(ev);
		expect(msg.lean).toBeUndefined();
		expect(msg.status).toBe('unverified');
	});

	it('treats a cache hit as Lean code, not an explanation, and labels it as cached', () => {
		const ev: AgentDoneEvent = {
			...base,
			cached: true,
			response: 'theorem t : True := trivial',
			reply: 'theorem t : True := trivial' // backend currently dupes response into reply on a cache hit
		};
		const msg = fromDone(ev);
		expect(msg.lean).toBe(ev.response);
		expect(msg.cached).toBe(true);
		expect(msg.steps[0].title).toBe('Cached result');
		expect(msg.steps.some((s) => s.explanation.includes(ev.response))).toBe(false);
	});

	it('renders a cache hit’s stored explanation as steps, keeping its Lean', () => {
		const ev: AgentDoneEvent = {
			...base,
			cached: true,
			tool_calls: [],
			response: 'import Mathlib\n\ntheorem t : True := trivial',
			reply:
				'```json\n' +
				JSON.stringify({
					intro: 'Short proof.',
					steps: [
						{ id: 's1', kind: 'theorem', title: 'Statement', summary: 'True holds.', leanLines: [3, 3] }
					]
				}) +
				'\n```'
		};
		const msg = fromDone(ev);
		expect(msg.cached).toBe(true);
		expect(msg.lean).toBe(ev.response);
		expect(msg.intro).toBe('Short proof.');
		expect(msg.steps[0].kind).toBe('theorem');
		expect(msg.steps[0].leanLines).toEqual([3, 3]);
	});

	it('parses a ```json steps block from the reply when present', () => {
		const ev: AgentDoneEvent = {
			...base,
			response: 'theorem t : True := trivial',
			reply:
				'```json\n' +
				JSON.stringify({
					intro: 'Short proof.',
					steps: [{ id: 's1', kind: 'theorem', title: 'Statement', summary: 'True holds.' }]
				}) +
				'\n```',
			tool_calls: [
				{
					name: 'check_lean_file',
					arguments: { path: 'T.lean' },
					result: { ok: true, messages: [], output: '', error: null }
				}
			]
		};
		const msg = fromDone(ev);
		expect(msg.intro).toBe('Short proof.');
		expect(msg.steps).toHaveLength(1);
		expect(msg.steps[0].title).toBe('Statement');
	});

	it('does not trust a `verified` flag inside the model-authored json block for the status', () => {
		// deriveStatus/fromDone must only consult ev.verified (B2, a backend
		// field) or the tool-call trace -- never parsed.verified from fromReply,
		// which is just the model talking about itself.
		const ev: AgentDoneEvent = {
			...base,
			response: 'theorem t : False := sorry',
			reply: '```json\n' + JSON.stringify({ steps: [{ summary: 'x' }], verified: true }) + '\n```',
			tool_calls: [
				{
					name: 'check_lean_file',
					arguments: { path: 'T.lean' },
					result: { ok: false, messages: [], output: 'error', error: null }
				}
			]
		};
		expect(fromDone(ev).status).toBe('unverified');
	});

	it('is "failed" when the agent did not finish', () => {
		const ev: AgentDoneEvent = { ...base, finished: false, response: '', reply: 'Stopped: reached max steps.' };
		expect(fromDone(ev).status).toBe('failed');
	});

	it('prefers the assumed lean_file field over the derived one when present', () => {
		const ev: AgentDoneEvent = {
			...base,
			response: 'theorem t : True := trivial',
			reply: 'Done.',
			lean_file: 'Assumed.lean'
		};
		expect(fromDone(ev).leanFile).toBe('Assumed.lean');
	});
});

describe('fromReply', () => {
	it('falls back to one Response step for malformed json', () => {
		const msg = fromReply('```json\n{ not valid json\n```\nSome prose.');
		expect(msg.steps).toHaveLength(1);
		expect(msg.steps[0].kind).toBe('response');
	});

	it('falls back when steps is an empty array', () => {
		const msg = fromReply('```json\n' + JSON.stringify({ steps: [] }) + '\n```');
		expect(msg.steps).toHaveLength(1);
		expect(msg.steps[0].kind).toBe('response');
	});

	it('normalises an unknown step kind to "step" instead of throwing', () => {
		const msg = fromReply(
			'```json\n' + JSON.stringify({ steps: [{ kind: 'not-a-real-kind', summary: 'x' }] }) + '\n```'
		);
		expect(msg.steps[0].kind).toBe('step');
	});

	it('is "failed" when the agent did not finish', () => {
		expect(fromReply('partial...', false).status).toBe('failed');
	});
});

describe('applyEvent (live timeline)', () => {
	it('merges consecutive tokens into one text item', () => {
		let msg = emptyLiveMessage('a1');
		msg = applyEvent(msg, { type: 'token', content: 'Hello' });
		msg = applyEvent(msg, { type: 'token', content: ', world' });
		expect(msg.live?.items).toEqual([{ kind: 'text', text: 'Hello, world' }]);
	});

	it('starts a new text item after a tool step, instead of merging across it', () => {
		let msg = emptyLiveMessage('a1');
		msg = applyEvent(msg, { type: 'token', content: 'Checking...' });
		msg = applyEvent(msg, { type: 'tool_call_start', id: 't1', name: 'check_lean_file' });
		msg = applyEvent(msg, {
			type: 'tool_result',
			id: 't1',
			name: 'check_lean_file',
			arguments: { path: 'P.lean' },
			result: { ok: true, messages: [], output: '', error: null }
		});
		msg = applyEvent(msg, { type: 'token', content: 'Done.' });
		expect(msg.live?.items).toEqual([
			{ kind: 'text', text: 'Checking...' },
			{ kind: 'tool', id: 't1', name: 'check_lean_file', state: 'ok', target: 'P.lean' },
			{ kind: 'text', text: 'Done.' }
		]);
	});

	it('matches a tool_result to its tool_call_start by id', () => {
		let msg = emptyLiveMessage('a1');
		msg = applyEvent(msg, { type: 'tool_call_start', id: 't1', name: 'check_lean_file' });
		msg = applyEvent(msg, {
			type: 'tool_result',
			id: 't1',
			name: 'check_lean_file',
			arguments: { path: 'P.lean' },
			result: { ok: true }
		});
		expect(msg.live?.items).toEqual([
			{ kind: 'tool', id: 't1', name: 'check_lean_file', state: 'ok', target: 'P.lean' }
		]);
	});

	it('matches by name when ids are empty (B6 fallback)', () => {
		let msg = emptyLiveMessage('a1');
		msg = applyEvent(msg, { type: 'tool_call_start', id: '', name: 'read_file' });
		msg = applyEvent(msg, {
			type: 'tool_result',
			id: '',
			name: 'read_file',
			arguments: {},
			result: { error: 'not found' }
		});
		expect(msg.live?.items).toEqual([{ kind: 'tool', id: '', name: 'read_file', state: 'failed', target: undefined, diagnostic: 'not found' }]);
	});

	it('does not confuse two concurrent calls with empty ids and different names', () => {
		let msg = emptyLiveMessage('a1');
		msg = applyEvent(msg, { type: 'tool_call_start', id: '', name: 'read_file' });
		msg = applyEvent(msg, { type: 'tool_call_start', id: '', name: 'list_files' });
		msg = applyEvent(msg, {
			type: 'tool_result',
			id: '',
			name: 'list_files',
			arguments: {},
			result: { files: [] }
		});
		expect(msg.live?.items).toEqual([
			{ kind: 'tool', id: '', name: 'read_file', state: 'running' },
			{ kind: 'tool', id: '', name: 'list_files', state: 'ok', target: undefined }
		]);
	});

	it('is a no-op once the message is no longer live (done already replaced it)', () => {
		const msg = fromReply('done');
		expect(applyEvent(msg, { type: 'token', content: 'ignored' })).toBe(msg);
	});

	it('is a no-op once the draft has been stopped or errored (events still in flight)', () => {
		let msg = emptyLiveMessage('a1');
		msg = applyEvent(msg, { type: 'token', content: 'partial' });
		const stopped = endLive(msg, 'stopped');
		const afterStop = applyEvent(stopped, { type: 'token', content: ' more' });
		expect(afterStop).toBe(stopped);
		expect(afterStop.live?.items).toEqual([{ kind: 'text', text: 'partial' }]);
	});
});

describe('endLive', () => {
	it('keeps the existing items and sets the state', () => {
		let msg = emptyLiveMessage('a1');
		msg = applyEvent(msg, { type: 'token', content: 'partial work' });
		const stopped = endLive(msg, 'stopped');
		expect(stopped.live).toEqual({ state: 'stopped', items: [{ kind: 'text', text: 'partial work' }] });
	});

	it('records the error detail for a stream error', () => {
		let msg = emptyLiveMessage('a1');
		const errored = endLive(msg, 'error', 'connection lost');
		expect(errored.live?.state).toBe('error');
		expect(errored.live?.errorDetail).toBe('connection lost');
	});

	it('is idempotent: calling it twice does not throw or lose data', () => {
		let msg = emptyLiveMessage('a1');
		msg = applyEvent(msg, { type: 'token', content: 'x' });
		const once = endLive(msg, 'stopped');
		const twice = endLive(once, 'stopped');
		expect(twice).toEqual(once);
	});

	it('is a no-op on a message with no live draft', () => {
		const msg = fromReply('done');
		expect(endLive(msg, 'stopped')).toBe(msg);
	});
});

describe('finalizeLive', () => {
	const doneEvent: AgentDoneEvent = {
		type: 'done',
		cached: false,
		query_id: 'q1',
		response: 'theorem t : True := trivial',
		reply: 'Done.',
		finished: true,
		tool_calls: [
			{
				name: 'check_lean_file',
				arguments: { path: 'T.lean' },
				result: { ok: true, messages: [], output: '', error: null }
			}
		]
	};

	it('keeps the draft id so the card does not jump', () => {
		let draft = emptyLiveMessage('draft-1');
		draft = applyEvent(draft, { type: 'token', content: 'Checking...' });
		const final = finalizeLive(draft, doneEvent);
		expect(final.id).toBe('draft-1');
		expect(final.live).toBeUndefined();
	});

	it('folds the live timeline into trace', () => {
		let draft = emptyLiveMessage('draft-1');
		draft = applyEvent(draft, { type: 'tool_call_start', id: 't1', name: 'check_lean_file' });
		draft = applyEvent(draft, {
			type: 'tool_result',
			id: 't1',
			name: 'check_lean_file',
			arguments: { path: 'T.lean' },
			result: { ok: true, messages: [], output: '', error: null }
		});
		const final = finalizeLive(draft, doneEvent);
		expect(final.trace).toEqual([{ kind: 'tool', id: 't1', name: 'check_lean_file', state: 'ok', target: 'T.lean' }]);
	});

	it('omits trace entirely when the draft collected nothing', () => {
		const draft = emptyLiveMessage('draft-1');
		const final = finalizeLive(draft, doneEvent);
		expect(final.trace).toBeUndefined();
	});

	it('still derives status the same way fromDone does, not from the trace', () => {
		const draft = emptyLiveMessage('draft-1');
		const final = finalizeLive(draft, doneEvent);
		expect(final.status).toBe('verified');
	});
});

describe('toolSucceeded', () => {
	it('is false for an {error} result', () => {
		expect(toolSucceeded({ error: 'boom' })).toBe(false);
	});
	it('reflects a Lean result\'s own ok field', () => {
		expect(toolSucceeded({ ok: false })).toBe(false);
		expect(toolSucceeded({ ok: true })).toBe(true);
	});
	it('is true for a plain result object with neither field (e.g. write_file)', () => {
		expect(toolSucceeded({ result: 'wrote 12 bytes' })).toBe(true);
	});
});

describe('fromTurn', () => {
	const turn: HistoryTurn = {
		query_id: 'q1',
		model: 'anthropic/claude-sonnet-4.5',
		query: 'prove that n + 0 = n',
		response: 'theorem t (n : Nat) : n + 0 = n := by simp',
		created_at: '2026-11-21T00:00:00Z'
	};

	it('builds a user/assistant pair with ids derived from query_id', () => {
		const [user, assistant] = fromTurn(turn);
		expect(user).toEqual({ id: 'u-q1', role: 'user', text: turn.query });
		expect(assistant.id).toBe('a-q1');
		expect(assistant.lean).toBe(turn.response);
		expect(assistant.cached).toBe(true);
		expect(assistant.status).toBe('unverified');
	});

	it('uses the stored reply as the explanation when present and different from the response', () => {
		const [, assistant] = fromTurn({ ...turn, reply: 'This uses `simp` to close the goal.' });
		expect(assistant.steps[0].explanation).toContain('simp');
	});

	it('ignores reply when it just duplicates response (no explanation was ever stored)', () => {
		const [, assistant] = fromTurn({ ...turn, reply: turn.response });
		expect(assistant.steps[0].title).toBe('Lean proof');
	});
});

describe('accounts', () => {
	it('signs up and logs in with a JSON body and surfaces the backend detail on failure', async () => {
		const fetcher = vi.fn()
			.mockResolvedValueOnce(jsonResponse({ user: { id: 'u1', email: 'a@b.co' } }, 201))
			.mockResolvedValueOnce(jsonResponse({ detail: 'An account with this email already exists' }, 409))
			.mockResolvedValueOnce(jsonResponse({ detail: 'Invalid email or password' }, 401));
		vi.stubGlobal('fetch', fetcher);
		expect(await signup('a@b.co', 'password1')).toEqual({ id: 'u1', email: 'a@b.co' });
		expect(fetcher.mock.calls[0][0]).toBe('/api/auth/signup');
		expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'include' });
		expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ email: 'a@b.co', password: 'password1' });
		await expect(signup('a@b.co', 'password1')).rejects.toMatchObject({ status: 409, message: 'An account with this email already exists' });
		await expect(login('a@b.co', 'nope')).rejects.toMatchObject({ status: 401, message: 'Invalid email or password' });
		expect(fetcher.mock.calls[2][0]).toBe('/api/auth/login');
	});

	it('reads the current user, null for a guest, and logs out', async () => {
		const fetcher = vi.fn()
			.mockResolvedValueOnce(jsonResponse({ user: null }))
			.mockResolvedValueOnce(jsonResponse({ user: { id: 'u1', email: 'a@b.co' } }))
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		vi.stubGlobal('fetch', fetcher);
		expect(await getMe()).toBeNull();
		expect(await getMe()).toEqual({ id: 'u1', email: 'a@b.co' });
		await logout();
		expect(fetcher.mock.calls[2][0]).toBe('/api/auth/logout');
	});

	it('re-checks the session after the identity changes', async () => {
		const fetcher = vi.fn()
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(jsonResponse({ user: { id: 'u1', email: 'a@b.co' } }))
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		vi.stubGlobal('fetch', fetcher);
		await ensureSession();
		await login('a@b.co', 'password1');
		await ensureSession();
		expect(fetcher.mock.calls.map((c) => c[0])).toEqual(['/api/session', '/api/auth/login', '/api/session']);
	});
});
