import { type DispatchTangentResult, dispatchTangent } from "../../task/dispatch-tangent";
import type { InteractiveModeContext } from "../types";

export class TanCommandController {
	constructor(private readonly ctx: InteractiveModeContext) {}

	async start(work: string): Promise<void> {
		if (!work.trim()) {
			this.ctx.showStatus("Usage: /tan <work>");
			return;
		}
		const wasStreaming = this.ctx.session.isStreaming;
		let result: DispatchTangentResult;
		try {
			result = await dispatchTangent(work, {
				session: this.ctx.session,
				sessionManager: this.ctx.sessionManager,
				settings: this.ctx.settings,
				mcpManager: this.ctx.mcpManager,
			});
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
			return;
		}
		// While streaming, the live renderer shows the queued breadcrumb on the next
		// turn; when idle the breadcrumb is already appended, so refresh the chat.
		if (!wasStreaming) this.ctx.rebuildChatFromMessages();
		this.ctx.showStatus(`Dispatched background tan ${result.jobId}`);
	}
}
