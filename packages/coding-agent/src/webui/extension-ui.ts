/**
 * Web extension UI context — the abstract {@link ExtensionUIContext} tier
 * (select/confirm/input/editor/notify/setStatus/…) routed over the web control
 * channel as {@link WebExtUIRequest} frames, resolved by {@link WebExtUIResponse}
 * frames the gateway feeds back. Structurally mirrors `RpcExtensionUIContext`.
 *
 * Component-tier methods (custom/setFooter/setHeader/setEditorComponent) are
 * no-ops here: they hand back a live TUI object that does not serialize. The
 * browser equivalent is the extension web-panel surface (Tier 2), wired
 * separately through the gateway, not through this dialog channel.
 */

import { Snowflake } from "@oh-my-pi/pi-utils";
import type { WebExtUIRequest, WebExtUIResponse } from "@oh-my-pi/pi-wire/web";
import {
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionUISelectItem,
	type ExtensionWidgetOptions,
	getExtensionUISelectOptionLabel,
} from "../extensibility/extensions";
import { type Theme, theme } from "../modes/theme/theme";

export interface PendingExtensionUIRequest {
	resolve: (response: WebExtUIResponse) => void;
	reject: (error: Error) => void;
}

/** Distributive omit so each request variant keeps its own fields when `id` is stripped. */
type WebExtUIRequestBody = WebExtUIRequest extends infer T
	? T extends WebExtUIRequest
		? Omit<T, "id">
		: never
	: never;

function parseValueResponse(
	response: WebExtUIResponse,
	opts: ExtensionUIDialogOptions | undefined,
): string | undefined {
	if ("cancelled" in response && response.cancelled) {
		if (response.timedOut) opts?.onTimeout?.();
		return undefined;
	}
	if ("value" in response) return response.value;
	return undefined;
}

/**
 * @param pendingRequests shared map keyed by request id; the gateway routes
 *   inbound `ext-ui-response` frames into it.
 * @param emit broadcasts a request frame to the control peer(s).
 */
export class WebExtensionUIContext implements ExtensionUIContext {
	constructor(
		private readonly pendingRequests: Map<string, PendingExtensionUIRequest>,
		private readonly emit: (request: WebExtUIRequest) => void,
	) {}

	#dialog<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: WebExtUIRequestBody,
		parse: (response: WebExtUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
		const id = Snowflake.next() as string;
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let timeoutId: Timer | undefined;

		const cleanup = () => {
			clearTimeout(timeoutId);
			opts?.signal?.removeEventListener("abort", onAbort);
			this.pendingRequests.delete(id);
		};
		const onAbort = () => {
			cleanup();
			resolve(defaultValue);
		};
		opts?.signal?.addEventListener("abort", onAbort, { once: true });
		if (opts?.timeout !== undefined) {
			timeoutId = setTimeout(() => {
				opts.onTimeout?.();
				cleanup();
				resolve(defaultValue);
			}, opts.timeout);
		}
		this.pendingRequests.set(id, {
			resolve: response => {
				cleanup();
				resolve(parse(response));
			},
			reject,
		});
		this.emit({ id, ...request } as WebExtUIRequest);
		return promise;
	}

	select(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return this.#dialog(
			dialogOptions,
			undefined,
			{
				method: "select",
				title,
				options: options.map(getExtensionUISelectOptionLabel),
				timeout: dialogOptions?.timeout,
			},
			response => parseValueResponse(response, dialogOptions),
		);
	}

	confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
		return this.#dialog(
			dialogOptions,
			false,
			{ method: "confirm", title, message, timeout: dialogOptions?.timeout },
			response => {
				if ("cancelled" in response && response.cancelled) {
					if (response.timedOut) dialogOptions?.onTimeout?.();
					return false;
				}
				if ("confirmed" in response) return response.confirmed;
				return false;
			},
		);
	}

	input(title: string, placeholder?: string, dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined> {
		return this.#dialog(
			dialogOptions,
			undefined,
			{ method: "input", title, placeholder, timeout: dialogOptions?.timeout },
			response => parseValueResponse(response, dialogOptions),
		);
	}

	editor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		return this.#dialog(
			dialogOptions,
			undefined,
			{ method: "editor", title, prefill, timeout: dialogOptions?.timeout, promptStyle: editorOptions?.promptStyle },
			response => parseValueResponse(response, dialogOptions),
		);
	}

	notify(message: string, type?: "info" | "warning" | "error"): void {
		this.emit({ id: Snowflake.next() as string, method: "notify", message, notifyType: type });
	}

	setStatus(key: string, text: string | undefined): void {
		this.emit({ id: Snowflake.next() as string, method: "setStatus", statusKey: key, statusText: text });
	}

	setTitle(title: string): void {
		this.emit({ id: Snowflake.next() as string, method: "setTitle", title });
	}

	setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
		if (content === undefined || Array.isArray(content)) {
			this.emit({
				id: Snowflake.next() as string,
				method: "setWidget",
				widgetKey: key,
				widgetLines: content as string[] | undefined,
				widgetPlacement: options?.placement,
			});
		}
	}

	setEditorText(text: string): void {
		this.emit({ id: Snowflake.next() as string, method: "set_editor_text", text });
	}

	pasteToEditor(text: string): void {
		this.setEditorText(text);
	}

	getEditorText(): string {
		return "";
	}

	onTerminalInput(): () => void {
		return () => {};
	}

	setWorkingMessage(_message?: string): void {}
	setFooter(_factory: unknown): void {}
	setHeader(_factory: unknown): void {}
	setEditorComponent(): void {}

	async custom<T>(): Promise<T> {
		return undefined as T;
	}

	get theme(): Theme {
		return theme;
	}

	getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
		return Promise.resolve([]);
	}

	getTheme(_name: string): Promise<Theme | undefined> {
		return Promise.resolve(undefined);
	}

	setTheme(_theme: string | Theme): Promise<{ success: boolean; error?: string }> {
		return Promise.resolve({ success: false, error: "Theme switching not supported over the web channel" });
	}

	getToolsExpanded(): boolean {
		return false;
	}

	setToolsExpanded(_expanded: boolean): void {}
}
