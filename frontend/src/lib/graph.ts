import dagre from '@dagrejs/dagre';
import type { ProofGraph, ProofGraphNode } from './types';

const record = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const dependencyList = (v: unknown): v is string[] | null =>
	v === null || (Array.isArray(v) && v.every(nonempty));

/** Validate wire data before it reaches the renderer. Never silently drop an edge. */
export function parseProofGraph(raw: unknown, queryId: string): ProofGraph {
	if (!record(raw) || raw.query_id !== queryId || !nonempty(raw.root_node_id) || !Array.isArray(raw.nodes)) {
		throw new Error('Invalid graph response or mismatched proof ID.');
	}
	const ids = new Set<string>();
	const nodes: ProofGraphNode[] = raw.nodes.map((node: unknown) => {
		if (!record(node) || !nonempty(node.node_id) || ids.has(node.node_id)) {
			throw new Error('Graph contains a missing or duplicate node ID.');
		}
		ids.add(node.node_id);
		if (!dependencyList(node.depends_on_ids)) {
			throw new Error('Invalid dependency list.');
		}
		const kind = node.kind ?? null;
		if (kind !== null && kind !== 'theorem' && kind !== 'technical') throw new Error('Invalid declaration kind.');
		const proofDeps = node.proof_dependency_ids ?? null;
		if (!dependencyList(proofDeps)) throw new Error('Invalid proof dependency list.');
		for (const field of ['lean_name', 'statement', 'explanation']) {
			if (node[field] !== undefined && typeof node[field] !== 'string') throw new Error(`Invalid node ${field}.`);
		}
		return {
			node_id: node.node_id,
			depends_on_ids: node.depends_on_ids === null ? null : [...new Set(node.depends_on_ids)],
			kind,
			proof_dependency_ids: proofDeps === null ? null : [...new Set(proofDeps)],
			...(typeof node.lean_name === 'string' && { lean_name: node.lean_name }),
			...(typeof node.statement === 'string' && { statement: node.statement }),
			...(typeof node.explanation === 'string' && { explanation: node.explanation })
		};
	});
	if (!ids.has(raw.root_node_id)) throw new Error('Graph root is missing.');
	const theoremIds = new Set(nodes.filter((node) => node.kind === 'theorem').map((node) => node.node_id));
	for (const node of nodes) {
		for (const dep of node.depends_on_ids ?? []) {
			if (!ids.has(dep)) throw new Error(`Graph references a missing node: ${dep}`);
		}
		if (node.proof_dependency_ids !== null && node.proof_dependency_ids !== undefined &&
			(node.kind !== 'theorem' || node.proof_dependency_ids.some((id) => !theoremIds.has(id) || !node.depends_on_ids?.includes(id)))) {
			throw new Error('Invalid edge between proof declarations.');
		}
	}
	return { query_id: queryId, root_node_id: raw.root_node_id, nodes };
}

export const nodeLabel = (node: ProofGraphNode) => node.lean_name || node.node_id;

export function graphEdges(graph: ProofGraph) {
	return graph.nodes.flatMap((n) => [...new Set(n.depends_on_ids ?? [])].map((target) => ({
		id: JSON.stringify([n.node_id, target]), source: n.node_id, target
	})));
}

export function usedBy(graph: ProofGraph, id: string): ProofGraphNode[] {
	return graph.nodes.filter((n) => n.depends_on_ids?.includes(id));
}

/** Follow the selected branches, or all branches if none were specified. */
export function visibleGraph(graph: ProofGraph, expanded?: ReadonlySet<string>): ProofGraph {
	const byId = new Map(graph.nodes.map((n) => [n.node_id, n]));
	const seen = new Set([graph.root_node_id]);
	const pending = [graph.root_node_id];
	for (let i = 0; i < pending.length; i++) {
		const id = pending[i];
		if (expanded && !expanded.has(id)) continue;
		for (const dep of byId.get(id)?.depends_on_ids ?? []) {
			if (!seen.has(dep)) {
				seen.add(dep);
				pending.push(dep);
			}
		}
	}
	// Preserve the canonical lists. Only the renderer filters edges to hidden targets.
	return { ...graph, nodes: graph.nodes.filter((n) => seen.has(n.node_id)) };
}

/** Use only actual references between named results. Never connect through hidden nodes. */
export function theoremView(graph: ProofGraph): ProofGraph | null {
	const nodes = graph.nodes.filter((node) => node.kind === 'theorem');
	if (!nodes.some((node) => node.node_id === graph.root_node_id)) return null;
	return visibleGraph({
		...graph,
		nodes: nodes.map((node) => ({ ...node, depends_on_ids: node.proof_dependency_ids ?? null }))
	});
}

/**
 * Edges to draw: drop `A → C` when another visible path `A → … → C` already shows it.
 * Uses only the nodes in `graph`, so a path through a hidden node never removes an edge.
 * Cyclic graphs are left as they are, since removing edges there can disconnect nodes.
 */
export function reducedEdges(graph: ProofGraph) {
	const ids = new Set(graph.nodes.map((n) => n.node_id));
	const edges = graphEdges(graph).filter((e) => ids.has(e.target));
	const succ = new Map<string, string[]>([...ids].map((id) => [id, []]));
	for (const e of edges) succ.get(e.source)!.push(e.target);

	// reach(id) is every node reachable from id, id excluded. 1 = visiting, which means a cycle.
	const reach = new Map<string, Set<string>>();
	const state = new Map<string, 1 | 2>();
	const visit = (id: string): Set<string> | null => {
		if (state.get(id) === 2) return reach.get(id)!;
		if (state.get(id) === 1) return null;
		state.set(id, 1);
		const out = new Set<string>();
		for (const next of succ.get(id)!) {
			const sub = visit(next);
			if (!sub) return null;
			out.add(next);
			for (const r of sub) out.add(r);
		}
		state.set(id, 2);
		reach.set(id, out);
		return out;
	};
	for (const id of ids) if (!visit(id)) return edges;

	return edges.filter((e) =>
		!succ.get(e.source)!.some((other) => other !== e.target && reach.get(other)!.has(e.target)));
}

export const NODE_WIDTH = 230;
export const NODE_HEIGHT = 86;

export function layoutGraph(graph: ProofGraph) {
	const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
	g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 75, marginx: 24, marginy: 24 });
	const edges = reducedEdges(graph);
	for (const n of [...graph.nodes].sort((a, b) => a.node_id.localeCompare(b.node_id))) {
		g.setNode(n.node_id, { width: NODE_WIDTH, height: NODE_HEIGHT });
	}
	for (const e of edges) g.setEdge(e.source, e.target);
	dagre.layout(g);
	return {
		nodes: graph.nodes.map((node) => ({
			id: node.node_id,
			type: 'declaration',
			position: { x: g.node(node.node_id).x - NODE_WIDTH / 2, y: g.node(node.node_id).y - NODE_HEIGHT / 2 },
			data: { node, root: node.node_id === graph.root_node_id },
			width: NODE_WIDTH, height: NODE_HEIGHT
		})),
		edges
	};
}
