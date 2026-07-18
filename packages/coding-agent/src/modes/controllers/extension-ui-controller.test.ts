import { describe, expect, it, vi } from "bun:test";
import { Container } from "@oh-my-pi/pi-tui";
import type { ExtensionUIContext, TerminalInputHandler } from "../../extensibility/extensions";
import { CustomEditor } from "../components/custom-editor";
import { getEditorTheme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { ExtensionUiController } from "./extension-ui-controller";

function makeHarness() {
	const editor = new CustomEditor(getEditorTheme());
	const requestRender = vi.fn();
	const addAutocompleteProvider = vi.fn();
	const inputListeners = new Set<TerminalInputHandler>();
	const addInputListener = vi.fn((handler: TerminalInputHandler) => {
		inputListeners.add(handler);
		return () => inputListeners.delete(handler);
	});
	const statusLine = { setHookStatus: vi.fn() };
	const hookWidgetContainerAbove = new Container();
	const hookWidgetContainerBelow = new Container();
	const editorContainer = new Container();
	const setEditorComponent = vi.fn();
	const setWorkingMessage = vi.fn();
	let uiContext: ExtensionUIContext | undefined;
	const ctx = {
		editor,
		ui: {
			requestRender,
			addInputListener,
			setFocus: vi.fn(),
			terminal: { rows: 40 },
		},
		session: {
			extensionRunner: undefined,
		},
		sessionManager: {
			getSessionName: () => "test",
			getCwd: () => "/tmp",
		},
		statusLine,
		hookWidgetContainerAbove,
		hookWidgetContainerBelow,
		editorContainer,
		setWorkingMessage,
		setEditorComponent,
		setToolUIContext(context: ExtensionUIContext, hasUI: boolean): void {
			expect(hasUI).toBe(true);
			uiContext = context;
		},
		addAutocompleteProvider,
	} as unknown as InteractiveModeContext;
	const controller = new ExtensionUiController(ctx);

	return {
		editor,
		requestRender,
		addAutocompleteProvider,
		addInputListener,
		inputListeners,
		statusLine,
		controller,
		async init(): Promise<ExtensionUIContext> {
			await controller.initHooksAndCustomTools();
			expect(uiContext).toBeDefined();
			return uiContext!;
		},
	};
}

describe("ExtensionUiController editor UI", () => {
	it("requests a render after extension pasteToEditor mutates the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.pasteToEditor("hello");
		ui.pasteToEditor(" world");

		expect(harness.editor.getText()).toBe("hello world");
		expect(harness.requestRender).toHaveBeenCalledTimes(2);
	});

	it("swaps generation-owned listeners and widgets only after reload commit", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const oldListener = vi.fn();
		const newListener = vi.fn();

		ui.onTerminalInput(oldListener);
		ui.setWidget("generation", ["old"]);
		ui.setStatus("generation", "old");
		expect(harness.inputListeners.has(oldListener)).toBe(true);
		expect(harness.statusLine.setHookStatus).toHaveBeenCalledWith("generation", "old");

		harness.controller.beginReloadGeneration();
		ui.onTerminalInput(newListener);
		ui.setWidget("generation", ["new"]);
		ui.setStatus("generation", "new");
		expect(harness.inputListeners.has(oldListener)).toBe(true);
		expect(harness.inputListeners.has(newListener)).toBe(false);

		harness.controller.rollbackReloadGeneration();
		expect(harness.inputListeners.has(oldListener)).toBe(true);
		expect(harness.inputListeners.has(newListener)).toBe(false);

		harness.controller.beginReloadGeneration();
		ui.onTerminalInput(newListener);
		ui.setWidget("generation", ["new"]);
		ui.setStatus("generation", "new");
		harness.controller.commitReloadGeneration();
		expect(harness.inputListeners.has(oldListener)).toBe(false);
		expect(harness.inputListeners.has(newListener)).toBe(true);
		expect(harness.statusLine.setHookStatus).toHaveBeenLastCalledWith("generation", "new");
	});

	it("requests a render after extension setEditorText replaces the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.setEditorText("hello");

		expect(harness.editor.getText()).toBe("hello");
		expect(harness.requestRender).toHaveBeenCalledTimes(1);
	});

	it("bridges addAutocompleteProvider factories to the interactive mode context (#4919)", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		expect(typeof ui.addAutocompleteProvider).toBe("function");

		const factory = (current: unknown) => current as never;
		ui.addAutocompleteProvider(factory);

		expect(harness.addAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(harness.addAutocompleteProvider).toHaveBeenCalledWith(factory);
	});
});
