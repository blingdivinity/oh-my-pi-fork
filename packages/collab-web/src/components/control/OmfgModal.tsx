import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { LocalClient } from "../../lib/local-client";

interface OmfgModalProps {
	client: LocalClient;
	/** Prefilled complaint from `/omfg <complaint>` (may be empty). */
	complaint?: string;
	onClose: () => void;
}

interface Candidate {
	ruleName: string;
	fileContent: string;
	validated: boolean;
}

type Level = "project" | "user";

/**
 * Web counterpart to the TUI `/omfg`: forge a TTSR rule from a complaint, review
 * the generated rule, optionally amend, then save to project or global rules.
 */
export function OmfgModal({ client, complaint: initial, onClose }: OmfgModalProps): ReactNode {
	const [complaint, setComplaint] = useState(initial ?? "");
	const [candidate, setCandidate] = useState<Candidate | null>(null);
	const [level, setLevel] = useState<Level>("project");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [savedPath, setSavedPath] = useState<string | null>(null);
	const [amendOpen, setAmendOpen] = useState(false);
	const [feedback, setFeedback] = useState("");
	const [needsOverwrite, setNeedsOverwrite] = useState<string | null>(null);

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

	const forge = async (amendFeedback?: string): Promise<void> => {
		if (!complaint.trim() || busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await client.omfgForge(complaint.trim(), amendFeedback, candidate?.fileContent);
			if ("error" in res) {
				setError(res.error);
			} else {
				setCandidate(res);
				setAmendOpen(false);
				setFeedback("");
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const save = async (overwrite?: boolean): Promise<void> => {
		if (!candidate || busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await client.omfgSave(candidate.ruleName, candidate.fileContent, level, overwrite);
			if ("needsOverwrite" in res) {
				setNeedsOverwrite(res.needsOverwrite);
			} else if ("error" in res) {
				setError(res.error);
			} else {
				setSavedPath(res.savedPath);
				setNeedsOverwrite(null);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="lc-modal-backdrop" onMouseDown={onClose}>
			<div className="lc-modal lc-omfg" onMouseDown={e => e.stopPropagation()}>
				<h3>Forge a TTSR rule</h3>
				{savedPath ? (
					<>
						<div className="lc-omfg-saved">Saved rule to {savedPath}</div>
						<div className="lc-modal-actions">
							<button type="button" onClick={onClose}>
								Done
							</button>
						</div>
					</>
				) : (
					<>
						<label className="lc-omfg-label" htmlFor="lc-omfg-complaint">
							Complaint (what recurring behavior should stop?)
						</label>
						<textarea
							id="lc-omfg-complaint"
							className="lc-omfg-complaint"
							value={complaint}
							disabled={busy}
							onChange={e => setComplaint(e.target.value)}
							placeholder="e.g. stop using `any` in TypeScript edits"
						/>
						{error && <div className="lc-omfg-error">{error}</div>}
						{candidate && (
							<>
								<div className="lc-omfg-badge" data-validated={candidate.validated}>
									{candidate.validated ? "✓ matched conversation" : "⚠ couldn't confirm a match"} ·{" "}
									{candidate.ruleName}
								</div>
								<pre className="lc-omfg-rule">{candidate.fileContent}</pre>
								<div className="lc-omfg-level">
									<label>
										<input
											type="radio"
											name="lc-omfg-level"
											checked={level === "project"}
											onChange={() => setLevel("project")}
										/>{" "}
										This project (.omp/rules)
									</label>
									<label>
										<input
											type="radio"
											name="lc-omfg-level"
											checked={level === "user"}
											onChange={() => setLevel("user")}
										/>{" "}
										Global (~/.omp/agent/rules)
									</label>
								</div>
								{needsOverwrite && (
									<div className="lc-omfg-overwrite">
										{needsOverwrite} exists.{" "}
										<button type="button" disabled={busy} onClick={() => void save(true)}>
											Overwrite
										</button>
									</div>
								)}
								{amendOpen && (
									<textarea
										className="lc-omfg-feedback"
										value={feedback}
										disabled={busy}
										onChange={e => setFeedback(e.target.value)}
										placeholder="How should the rule change? (e.g. scope to tool:write(*.rb))"
									/>
								)}
							</>
						)}
						<div className="lc-modal-actions">
							{!candidate && (
								<button type="button" disabled={busy || !complaint.trim()} onClick={() => void forge()}>
									{busy ? "Forging…" : "Forge rule"}
								</button>
							)}
							{candidate && !amendOpen && (
								<>
									<button type="button" disabled={busy} onClick={() => void save()}>
										Save
									</button>
									<button type="button" disabled={busy} onClick={() => setAmendOpen(true)}>
										Amend…
									</button>
								</>
							)}
							{candidate && amendOpen && (
								<button
									type="button"
									disabled={busy || !feedback.trim()}
									onClick={() => void forge(feedback.trim())}
								>
									{busy ? "Re-forging…" : "Re-forge"}
								</button>
							)}
							<button type="button" disabled={busy} onClick={onClose}>
								Cancel
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
