import type { ReactNode } from "react";
import type { LocalSnapshot } from "../../lib/local-client";
import "./todo-hud.css";

type TodoItem = NonNullable<NonNullable<LocalSnapshot["state"]>["todos"]>[number]["tasks"][number];

const STATUS_GLYPHS: Record<TodoItem["status"], string> = {
	pending: "○",
	in_progress: "◐",
	completed: "✓",
	abandoned: "✗",
};

function itemClass(status: TodoItem["status"]): string {
	let className = "lc-todo-item";
	if (status === "completed" || status === "abandoned") className += " lc-todo-item--done";
	if (status === "in_progress") className += " lc-todo-item--active";
	return className;
}

function isOpen(status: TodoItem["status"]): boolean {
	return status === "pending" || status === "in_progress";
}

export function TodoHud({ snapshot }: { snapshot: LocalSnapshot }): ReactNode {
	const phases = snapshot.state?.todos?.filter(phase => phase.tasks.length > 0) ?? [];
	if (phases.length === 0) return null;

	const openCount = phases.reduce((sum, phase) => {
		return (
			sum +
			phase.tasks.reduce((phaseSum, task) => {
				return phaseSum + (isOpen(task.status) ? 1 : 0);
			}, 0)
		);
	}, 0);

	return (
		<section className="lc-todo" aria-label="Todo list">
			<div className="lc-todo-header">
				<span>Todo</span>
				<span className="lc-todo-count">{openCount} open</span>
			</div>
			<div className="lc-todo-phases">
				{phases.map((phase, phaseIndex) => (
					<div key={`${phase.name}:${phaseIndex}`} className="lc-todo-phase">
						<div className="lc-todo-phase-name">{phase.name}</div>
						<ul className="lc-todo-list">
							{phase.tasks.map((task, taskIndex) => (
								<li key={`${task.content}:${taskIndex}`} className={itemClass(task.status)}>
									<span className="lc-todo-glyph" aria-hidden="true">
										{STATUS_GLYPHS[task.status]}
									</span>
									<span className="lc-todo-content">{task.content}</span>
								</li>
							))}
						</ul>
					</div>
				))}
			</div>
		</section>
	);
}
