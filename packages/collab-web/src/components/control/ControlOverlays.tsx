import type { WebExtUIRequest, WebToolApprovalRequest } from "@oh-my-pi/pi-wire/web";
import type { ReactNode } from "react";
import { useState } from "react";
import type { LocalClient, LocalSnapshot } from "../../lib/local-client";

interface ControlOverlaysProps {
	client: LocalClient;
	snapshot: LocalSnapshot;
}

export function ControlOverlays({ client, snapshot }: ControlOverlaysProps): ReactNode {
	return (
		<>
			{snapshot.pendingApproval && <ApprovalModal client={client} request={snapshot.pendingApproval} />}
			{snapshot.pendingExtUI && (
				// `key` resets dialog input state when the queue head changes.
				<ExtUiDialog key={snapshot.pendingExtUI.id} client={client} request={snapshot.pendingExtUI} />
			)}
		</>
	);
}

function ApprovalModal({ client, request }: { client: LocalClient; request: WebToolApprovalRequest }): ReactNode {
	return (
		<div className="lc-modal-backdrop">
			<div className="lc-modal">
				<h3>Approve {request.toolName}?</h3>
				{request.tier && <div className="lc-badge">capability: {request.tier}</div>}
				{request.details?.map((line, i) => (
					<div key={i}>{line}</div>
				))}
				<pre>{JSON.stringify(request.args, null, 2)}</pre>
				<div className="lc-modal-actions">
					<button type="button" onClick={() => void client.respondApproval(request.id, "deny")}>
						Deny
					</button>
					<button type="button" onClick={() => void client.respondApproval(request.id, "approve-always")}>
						Always
					</button>
					<button type="button" onClick={() => void client.respondApproval(request.id, "approve")}>
						Approve
					</button>
				</div>
			</div>
		</div>
	);
}

function ExtUiDialog({ client, request }: { client: LocalClient; request: WebExtUIRequest }): ReactNode {
	const [value, setValue] = useState(request.method === "editor" ? (request.prefill ?? "") : "");
	const cancel = (): void => client.respondExtUI({ id: request.id, cancelled: true });

	const title = "title" in request ? request.title : request.method;

	return (
		<div className="lc-modal-backdrop">
			<div className="lc-modal">
				<h3>{title}</h3>
				{request.method === "confirm" && <p>{request.message}</p>}
				{request.method === "select" && (
					<div className="lc-modal-actions" style={{ justifyContent: "flex-start" }}>
						{request.options.map(opt => (
							<button
								key={opt}
								type="button"
								onClick={() => client.respondExtUI({ id: request.id, value: opt })}
							>
								{opt}
							</button>
						))}
					</div>
				)}
				{(request.method === "input" || request.method === "editor") && (
					<input
						autoFocus
						value={value}
						placeholder={request.method === "input" ? (request.placeholder ?? "") : ""}
						onChange={e => setValue(e.target.value)}
						onKeyDown={e => {
							if (e.key === "Enter") client.respondExtUI({ id: request.id, value });
						}}
					/>
				)}
				<div className="lc-modal-actions">
					<button type="button" onClick={cancel}>
						Cancel
					</button>
					{request.method === "confirm" && (
						<>
							<button type="button" onClick={() => client.respondExtUI({ id: request.id, confirmed: false })}>
								No
							</button>
							<button type="button" onClick={() => client.respondExtUI({ id: request.id, confirmed: true })}>
								Yes
							</button>
						</>
					)}
					{(request.method === "input" || request.method === "editor") && (
						<button type="button" onClick={() => client.respondExtUI({ id: request.id, value })}>
							OK
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
