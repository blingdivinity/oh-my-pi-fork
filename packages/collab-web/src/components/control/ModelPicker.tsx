import type { WebModelInfo } from "@oh-my-pi/pi-wire/web";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LocalClient } from "../../lib/local-client";

interface ModelPickerProps {
	client: LocalClient;
	models: readonly WebModelInfo[];
	onClose: () => void;
}

/**
 * Web counterpart to the TUI model selector (`/model`, `/switch`, alt+m).
 * Lists available models as `provider/name` with the bare id, fuzzy-filterable,
 * current marked; arrow/Enter/Esc + click. Switches via `client.setModel`.
 */
export function ModelPicker({ client, models, onClose }: ModelPickerProps): ReactNode {
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const filtered = useMemo(() => {
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		return models.filter(m => {
			const hay = `${m.provider}/${m.name} ${m.modelId}`.toLowerCase();
			return terms.every(t => hay.includes(t));
		});
	}, [models, query]);

	useEffect(() => {
		setActive(a => (a >= filtered.length ? Math.max(0, filtered.length - 1) : a));
	}, [filtered.length]);

	useEffect(() => {
		listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
	}, [active]);

	const choose = (m: WebModelInfo | undefined): void => {
		if (m) void client.setModel(m.provider, m.modelId);
		onClose();
	};

	const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
		if (e.key === "Escape") {
			e.preventDefault();
			onClose();
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive(a => Math.min(a + 1, filtered.length - 1));
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
				<h3>Select model</h3>
				<input
					ref={inputRef}
					className="lc-picker-input"
					placeholder="Filter models…"
					value={query}
					onChange={e => {
						setQuery(e.target.value);
						setActive(0);
					}}
				/>
				<div className="lc-picker-list" ref={listRef}>
					{filtered.length === 0 && <div className="lc-picker-empty">no matching models</div>}
					{filtered.map((m, i) => (
						<div
							key={m.id}
							className="lc-picker-item"
							data-active={i === active}
							data-current={m.current === true}
							onMouseDown={e => {
								e.preventDefault();
								choose(m);
							}}
							onMouseEnter={() => setActive(i)}
						>
							<span className="lc-picker-name">
								{m.provider}/{m.name}
							</span>
							<span className="lc-picker-id">
								{m.modelId}
								{m.current ? "  ✓" : ""}
							</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
