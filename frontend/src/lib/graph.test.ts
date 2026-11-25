import { describe, expect, it } from 'vitest';
import { graphEdges, layoutGraph, reducedEdges, parseProofGraph, theoremView, usedBy, visibleGraph } from './graph';
import { mockGraph } from './mock';
import { createGraphLoader, type GraphState } from './graph-loader';
import type { ProofGraph } from './types';

const fixture = (kind = 'basic') => parseProofGraph(mockGraph(`mock-graph-${kind}`), `mock-graph-${kind}`);

describe('declaration graph', () => {
	it('preserves the agreed direction and computes reverse references', () => {
		const graph = fixture();
		expect(graphEdges(graph).map((e) => [e.source, e.target])).toEqual([['A', 'B'], ['A', 'C'], ['B', 'D']]);
		expect(usedBy(graph, 'B').map((n) => n.node_id)).toEqual(['A']);
		expect(graph.nodes.find((n) => n.node_id === 'B')?.depends_on_ids).toEqual(['D']);
	});
	it('does not duplicate shared nodes and lays out finite coordinates', () => {
		const { nodes, edges } = layoutGraph(fixture('shared'));
		expect(nodes.filter((n) => n.id === 'D')).toHaveLength(1);
		expect(edges.filter((e) => e.target === 'D')).toHaveLength(2);
		expect(nodes.every((n) => Number.isFinite(n.position.x) && Number.isFinite(n.position.y))).toBe(true);
	});
	it('preserves unknown dependencies separately from an empty list', () => {
		const graph = fixture('partial');
		expect(graph.nodes[2].depends_on_ids).toEqual([]);
		expect(graph.nodes[3].depends_on_ids).toBeNull();
	});
	it('reveals only expanded branches without destroying the original edges', () => {
		const graph = fixture('cycle');
		const initial = visibleGraph(graph, new Set(['A']));
		expect(initial.nodes.map((n) => n.node_id)).toEqual(['A', 'B', 'C']);
		expect(visibleGraph(graph, new Set(['A', 'B'])).nodes).toHaveLength(4);
		expect(visibleGraph(graph).nodes).toHaveLength(4);
		expect(layoutGraph(initial).edges).toHaveLength(2);
		expect(graphEdges(graph)).toContainEqual({ id: '["D","A"]', source: 'D', target: 'A' });
	});
	it('shows direct proof references and never draws a shortcut through technical declarations', () => {
		const graph = parseProofGraph({ query_id: 'proof', root_node_id: 'main', nodes: [
			{ node_id: 'main', kind: 'theorem', depends_on_ids: ['helper', 'type', 'tactic'], proof_dependency_ids: ['helper'] },
			{ node_id: 'helper', kind: 'theorem', depends_on_ids: ['lemma'], proof_dependency_ids: ['lemma'] },
			{ node_id: 'lemma', kind: 'theorem', depends_on_ids: null, proof_dependency_ids: null },
			{ node_id: 'type', kind: 'technical', depends_on_ids: [] },
			{ node_id: 'tactic', kind: 'technical', depends_on_ids: ['hiddenLemma'] },
			{ node_id: 'hiddenLemma', kind: 'theorem', depends_on_ids: [], proof_dependency_ids: [] }
		] }, 'proof');
		const overview = theoremView(graph)!;
		const initial = visibleGraph(overview, new Set(['main']));
		expect(initial.nodes.map((n) => n.node_id)).toEqual(['main', 'helper']);
		expect(graphEdges(overview).map((e) => [e.source, e.target])).toEqual([['main', 'helper'], ['helper', 'lemma']]);
		expect(overview.nodes[2].depends_on_ids).toBeNull();
		expect(graph.nodes).toHaveLength(6);
	});

	it('hides shortcut edges already implied by a longer visible path', () => {
		const graph = parseProofGraph({ query_id: 'tr', root_node_id: 'A', nodes: [
			{ node_id: 'A', depends_on_ids: ['B', 'C', 'D'] },
			{ node_id: 'B', depends_on_ids: ['C'] },
			{ node_id: 'C', depends_on_ids: ['D'] },
			{ node_id: 'D', depends_on_ids: [] }
		] }, 'tr');
		const pairs = (es: { source: string; target: string }[]) => es.map((e) => [e.source, e.target]);
		expect(pairs(reducedEdges(graph))).toEqual([['A', 'B'], ['B', 'C'], ['C', 'D']]);
		expect(pairs(layoutGraph(graph).edges)).toEqual([['A', 'B'], ['B', 'C'], ['C', 'D']]);
		// The canonical data and the full edge list keep every direct reference.
		expect(graph.nodes[0].depends_on_ids).toEqual(['B', 'C', 'D']);
		expect(graphEdges(graph)).toHaveLength(5);
	});
	it('keeps an edge whose only alternative path runs through a hidden node', () => {
		const shown: ProofGraph = { query_id: 'tr', root_node_id: 'A', nodes: [
			{ node_id: 'A', depends_on_ids: ['B', 'C'] },
			{ node_id: 'C', depends_on_ids: [] }
		] };
		expect(reducedEdges(shown).map((e) => [e.source, e.target])).toEqual([['A', 'C']]);
	});
	it('leaves cyclic graphs unreduced', () => {
		const graph = fixture('cycle');
		expect(reducedEdges(graph)).toEqual(graphEdges(graph));
	});

	it('requires Lean metadata before projecting a legacy graph', () => {
		const graph = parseProofGraph({ query_id: 'old', root_node_id: 'main', nodes: [
			{ node_id: 'main', depends_on_ids: [] }
		] }, 'old');
		expect(theoremView(graph)).toBeNull();
	});
	it('supports a single isolated theorem', () => {
		expect(layoutGraph(fixture('single')).nodes).toHaveLength(1);
		expect(graphEdges(fixture('single'))).toEqual([]);
	});
	it('rejects mismatched proof IDs, duplicate IDs, missing roots and missing targets', () => {
		expect(() => parseProofGraph(mockGraph('mock-graph-basic'), 'different')).toThrow();
		const graph = fixture();
		expect(() => parseProofGraph({ ...graph, nodes: [...graph.nodes, graph.nodes[0]] }, graph.query_id)).toThrow(/duplicate/);
		expect(() => parseProofGraph({ ...graph, root_node_id: 'missing' }, graph.query_id)).toThrow(/root/);
		expect(() => fixture('invalid')).toThrow(/missing node/);
	});
	it('deduplicates dependencies but rejects malformed lists and metadata', () => {
		const graph = fixture();
		graph.nodes[0].depends_on_ids = ['B', 'B', 'C'];
		expect(graphEdges(parseProofGraph(graph, graph.query_id))).toHaveLength(3);
		for (const depends_on_ids of [undefined, 'B', [4], ['']]) {
			expect(() => parseProofGraph({ ...graph, nodes: [{ node_id: 'A', depends_on_ids }] }, graph.query_id)).toThrow();
		}
		expect(() => parseProofGraph({ ...graph, nodes: [{ node_id: 'A', depends_on_ids: [], statement: 5 }] }, graph.query_id)).toThrow();
	});
});

describe('graph panel request lifecycle', () => {
	it('ignores a late response from the previous proof even if fetch ignores abort', async () => {
		const pending: Record<string, (graph: ProofGraph | null) => void> = {};
		const states: GraphState[] = [];
		const signals: AbortSignal[] = [];
		const loader = createGraphLoader((id, signal) => {
			signals.push(signal);
			return new Promise((resolve) => { pending[id] = resolve; });
		}, (state) => states.push(state));
		const first = loader.load('first');
		const second = loader.load('second');
		expect(signals[0].aborted).toBe(true);
		pending.second({ ...fixture(), query_id: 'second' });
		await second;
		pending.first({ ...fixture(), query_id: 'first' });
		await first;
		expect(states.at(-1)).toMatchObject({ kind: 'ready', graph: { query_id: 'second' } });
	});
	it('handles an unsaved proof and cancellation without showing a failure', async () => {
		const states: GraphState[] = [];
		let resolve!: (g: ProofGraph | null) => void;
		const loader = createGraphLoader(() => new Promise((r) => { resolve = r; }), (s) => states.push(s));
		await loader.load(null);
		expect(states.at(-1)?.kind).toBe('unsaved');
		const task = loader.load('one');
		loader.cancel(); resolve(fixture()); await task;
		expect(states.at(-1)?.kind).toBe('loading');
	});
});
