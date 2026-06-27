import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LocalClient } from "../../lib/local-client";

export function ForceSelector({ client, onClose }: { client: LocalClient; onClose: () => void }): ReactNode {
	const [tools, setTools] = useState<string[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let live = true;
		setTools(null);
		setError(null);
		void (async () => {
			try {
				const list = await client.getTools();
				if (live) setTools(list);
			} catch (err) {
				if (live) setError(String(err));
			}
		})();
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

	const filtered = useMemo(() => {
		const needle = query.toLowerCase();
		return (tools ?? []).filter(name => name.toLowerCase().includes(needle));
	}, [query, tools]);

	useEffect(() => {
		setActive(a => (filtered.length === 0 ? 0 : Math.min(a, filtered.length - 1)));
	}, [filtered.length]);

	useEffect(() => {
		listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
	}, [active]);

	const choose = (name: string | undefined): void => {
		if (!name) return;
		void client.runSlash(`/force ${name}`);
		onClose();
	};

	const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive(a => (filtered.length === 0 ? 0 : Math.min(a + 1, filtered.length - 1)));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive(a => Math.max(a - 1, 0));
		} else if (e.key === "Enter") {
			e.preventDefault();
			choose(filtered[active]);
		}
	};

	return (
		<div className="lc-modal-backdrop" onMouseDown={onClose}>
			<div className="lc-modal lc-picker" onMouseDown={e => e.stopPropagation()} onKeyDown={onKeyDown}>
				<h3>Force a tool</h3>
				<input
					autoFocus
					className="lc-picker-input"
					placeholder="Force a tool…"
					value={query}
					onChange={e => {
						setQuery(e.target.value);
						setActive(0);
					}}
				/>
				<div className="lc-picker-list" ref={listRef}>
					{tools === null && !error && <div className="lc-picker-empty">loading…</div>}
					{error && <div className="lc-picker-empty">failed to load tools: {error}</div>}
					{tools !== null && tools.length === 0 && <div className="lc-picker-empty">no active tools</div>}
					{tools !== null && tools.length > 0 && filtered.length === 0 && (
						<div className="lc-picker-empty">no matching tools</div>
					)}
					{filtered.map((name, i) => (
						<div
							key={name}
							className="lc-picker-item"
							data-active={i === active}
							onMouseDown={e => {
								e.preventDefault();
								choose(name);
							}}
							onMouseEnter={() => setActive(i)}
						>
							<span className="lc-picker-name">{name}</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
