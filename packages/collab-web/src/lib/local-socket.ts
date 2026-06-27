/**
 * Plaintext WebSocket transport for the local web UI profile.
 *
 * Unlike {@link CollabSocket} (AES-sealed relay frames), the local server is
 * same-origin and loopback, so frames are plain JSON. No envelope, no peer
 * routing, no relay control messages — exactly one host on the other end.
 * Standalone by design: the local client evolves independently of the relay
 * guest (see LocalClient).
 */

import type { GuestFrame, HostFrame } from "@oh-my-pi/pi-wire";
import type { WebControlEvent, WebControlFrame } from "@oh-my-pi/pi-wire/web";

/** Frames the host sends us (replication + control events). */
export type LocalInbound = HostFrame | WebControlEvent;
/** Frames we send the host (collab steer + control frames). */
export type LocalOutbound = GuestFrame | WebControlFrame;

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 10_000;

export interface LocalSocketOptions {
	/** Full ws(s):// URL including the auth token query. */
	url: string;
}

export class LocalSocket {
	onOpen?: () => void;
	onMessage?: (frame: LocalInbound) => void;
	/** willReconnect=true for transient drops that will retry. */
	onClose?: (reason: string, willReconnect: boolean) => void;

	readonly #url: string;
	#ws: WebSocket | null = null;
	#retryTimer: ReturnType<typeof setTimeout> | undefined;
	#attempt = 0;
	#closed = false;

	constructor(opts: LocalSocketOptions) {
		this.#url = opts.url;
	}

	get isOpen(): boolean {
		return this.#ws?.readyState === WebSocket.OPEN;
	}

	connect(): void {
		this.#closed = false;
		this.#open();
	}

	send(frame: LocalOutbound): void {
		if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(frame));
	}

	close(): void {
		this.#closed = true;
		clearTimeout(this.#retryTimer);
		this.#retryTimer = undefined;
		this.#ws?.close();
		this.#ws = null;
	}

	#open(): void {
		const ws = new WebSocket(this.#url);
		this.#ws = ws;
		ws.addEventListener("open", () => {
			this.#attempt = 0;
			this.onOpen?.();
		});
		ws.addEventListener("message", ev => {
			let frame: LocalInbound;
			try {
				frame = JSON.parse(String(ev.data)) as LocalInbound;
			} catch {
				return;
			}
			this.onMessage?.(frame);
		});
		ws.addEventListener("close", () => {
			if (this.#ws !== ws) return;
			this.#ws = null;
			if (this.#closed) {
				this.onClose?.("closed", false);
				return;
			}
			this.onClose?.("connection lost", true);
			this.#scheduleRetry();
		});
		ws.addEventListener("error", () => {
			// `close` always follows; reconnect is handled there.
		});
	}

	#scheduleRetry(): void {
		const delay = Math.min(BACKOFF_BASE_MS * 2 ** this.#attempt, BACKOFF_MAX_MS);
		this.#attempt++;
		clearTimeout(this.#retryTimer);
		this.#retryTimer = setTimeout(() => {
			if (!this.#closed) this.#open();
		}, delay);
	}
}
