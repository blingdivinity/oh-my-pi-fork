import type { WebSessionInfo } from "@oh-my-pi/pi-wire/web";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { LocalClient } from "../../lib/local-client";

interface TreeOverlayProps {
	client: LocalClient;
	onClose: () => void;
}

interface TreeNode {
	session: WebSessionInfo;
	children: TreeNode[];
}

/**
 * Build a forest from `parentPath` links. The stored parent reference is either
 * a session file path or a session id (it varies by how the fork was created),
 * so index nodes under both. Sessions whose parent is absent become roots.
 */
function buildForest(sessions: readonly WebSessionInfo[]): TreeNode[] {
	const nodes: TreeNode[] = [];
	const byKey = new Map<string, TreeNode>();
	for (const s of sessions) {
		const node: TreeNode = { session: s, children: [] };
		nodes.push(node);
		byKey.set(s.path, node);
		if (s.id) byKey.set(s.id, node);
	}
	const roots: TreeNode[] = [];
	for (const node of nodes) {
		const parent = node.session.parentPath ? byKey.get(node.session.parentPath) : undefined;
		if (parent && parent !== node) parent.children.push(node);
		else roots.push(node);
	}
	const byModified = (a: TreeNode, b: TreeNode): number => b.session.modified - a.session.modified;
	const sort = (nodes: TreeNode[]): void => {
		nodes.sort(byModified);
		for (const n of nodes) sort(n.children);
	};
	sort(roots);
	return roots;
}

function when(ms: number): string {
	const d = new Date(ms);
	return Number.isFinite(d.getTime()) && ms > 0 ? d.toLocaleString() : "";
}

/** Web counterpart to the TUI `/tree`: the fork/branch tree of saved sessions. */
export function TreeOverlay({ client, onClose }: TreeOverlayProps): ReactNode {
	const [sessions, setSessions] = useState<WebSessionInfo[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		client.listSessions().then(
			list => {
				if (live) setSessions(list);
			},
			err => {
				if (live) setError(String(err));
			},
		);
		return () => {
			live = false;
		};
	}, [client]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const forest = useMemo(() => (sessions ? buildForest(sessions) : []), [sessions]);

	const choose = (s: WebSessionInfo): void => {
		if (!s.current) void client.switchSession(s.path);
		onClose();
	};

	const renderNode = (node: TreeNode, depth: number): ReactNode => {
		const s = node.session;
		return (
			<div key={s.path}>
				<div
					className="lc-picker-item lc-tree-item"
					data-current={s.current}
					style={{ paddingLeft: `${8 + depth * 16}px` }}
					onMouseDown={e => {
						e.preventDefault();
						choose(s);
					}}
				>
					<span className="lc-picker-name">
						{depth > 0 ? "↳ " : ""}
						{s.title || s.firstMessage || s.id}
						{s.current ? "  ✓" : ""}
					</span>
					<span className="lc-picker-id">
						{s.messageCount} msgs · {when(s.modified)}
					</span>
				</div>
				{node.children.map(child => renderNode(child, depth + 1))}
			</div>
		);
	};

	return (
		<div className="lc-modal-backdrop" onMouseDown={onClose}>
			<div className="lc-modal lc-picker" onMouseDown={e => e.stopPropagation()}>
				<h3>Session tree</h3>
				<div className="lc-picker-list">
					{error && <div className="lc-picker-empty">failed to list sessions: {error}</div>}
					{sessions === null && !error && <div className="lc-picker-empty">loading…</div>}
					{sessions && sessions.length === 0 && <div className="lc-picker-empty">no saved sessions</div>}
					{forest.map(node => renderNode(node, 0))}
				</div>
			</div>
		</div>
	);
}
