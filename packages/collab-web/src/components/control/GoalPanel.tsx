import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { LocalClient, LocalSnapshot } from "../../lib/local-client";
import "./goal-panel.css";

export function GoalPanel({
	client,
	snapshot,
	onClose,
}: {
	client: LocalClient;
	snapshot: LocalSnapshot;
	onClose: () => void;
}): ReactNode {
	const [objective, setObjective] = useState("");
	const [budget, setBudget] = useState("");
	const goal = snapshot.state?.goalMode ?? null;
	const hasGoal = goal !== null;

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

	const setGoal = (): void => {
		const nextObjective = objective.trim();
		if (!nextObjective) return;
		void client.goalCommand("set", { objective: nextObjective });
		onClose();
	};

	const runGoalCommand = (action: "pause" | "resume" | "drop"): void => {
		if (!hasGoal) return;
		void client.goalCommand(action);
		onClose();
	};

	const setGoalBudget = (): void => {
		if (!hasGoal) return;
		const nextBudget = Number.parseInt(budget, 10);
		if (Number.isNaN(nextBudget)) return;
		void client.goalCommand("budget", { budget: nextBudget });
		onClose();
	};

	const clearGoalBudget = (): void => {
		if (!hasGoal) return;
		void client.goalCommand("budget", { budget: null });
		onClose();
	};

	return (
		<div className="lc-modal-backdrop" onMouseDown={onClose}>
			<div className="lc-modal lc-goal" onMouseDown={e => e.stopPropagation()}>
				<h3>Goal mode</h3>
				<div className="lc-goal-current">
					{goal ? (
						<>
							<div className="lc-goal-objective">{goal.objective}</div>
							<div className="lc-goal-status">Status: {goal.status}</div>
						</>
					) : (
						<div className="lc-goal-empty">No active goal</div>
					)}
				</div>

				<label className="lc-goal-label" htmlFor="lc-goal-objective">
					Objective
				</label>
				<textarea
					id="lc-goal-objective"
					className="lc-goal-textarea"
					value={objective}
					onChange={e => setObjective(e.currentTarget.value)}
					placeholder="Describe the goal for this session"
					rows={4}
				/>
				<div className="lc-goal-actions">
					<button type="button" onClick={setGoal} disabled={!objective.trim()}>
						Set goal
					</button>
					<button type="button" onClick={() => runGoalCommand("pause")} disabled={!hasGoal}>
						Pause
					</button>
					<button type="button" onClick={() => runGoalCommand("resume")} disabled={!hasGoal}>
						Resume
					</button>
					<button type="button" onClick={() => runGoalCommand("drop")} disabled={!hasGoal}>
						Drop
					</button>
				</div>

				<div className="lc-goal-budget">
					<label className="lc-goal-label" htmlFor="lc-goal-budget">
						Budget
					</label>
					<div className="lc-goal-budget-row">
						<input
							id="lc-goal-budget"
							className="lc-goal-budget-input"
							type="number"
							inputMode="numeric"
							value={budget}
							onChange={e => setBudget(e.currentTarget.value)}
							disabled={!hasGoal}
						/>
						<button type="button" onClick={setGoalBudget} disabled={!hasGoal}>
							Set budget
						</button>
						<button type="button" onClick={clearGoalBudget} disabled={!hasGoal}>
							Clear budget
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
