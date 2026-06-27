/**
 * Transport-agnostic types for the web UI session gateway.
 *
 * The gateway taps the UI-agnostic Layer-1 core (AgentSession, SessionManager,
 * EventBus, AgentRegistry, MCPManager) and fans serialized frames out to
 * {@link GatewayPeer}s. A peer is any duplex JSON channel — the local Bun.serve
 * WebSocket (plaintext, same-origin) or, in principle, a sealed collab relay
 * socket. The gateway never imports a transport or the TUI.
 */

import type { WebControlEvent, WebControlFrame } from "@oh-my-pi/pi-wire/web";
import type { CollabFrame } from "../collab/protocol";

/** Host → guest frames the gateway emits: collab replication frames + control events. */
export type GatewayHostFrame = Extract<
	CollabFrame,
	{ t: "welcome" | "snapshot-chunk" | "entry" | "event" | "state" | "bus" | "agents" | "transcript" | "bye" | "error" }
>;

/** Everything the gateway can send to a peer. */
export type GatewayOutbound = GatewayHostFrame | WebControlEvent;

/** Guest → host frames the gateway accepts: collab steer frames + control frames. */
export type GatewayGuestFrame = Extract<
	CollabFrame,
	{ t: "hello" | "prompt" | "abort" | "agent-cmd" | "fetch-transcript" }
>;

/** Everything a peer can send to the gateway. */
export type GatewayInbound = GatewayGuestFrame | WebControlFrame;

/**
 * One connected client. The transport owns serialization (JSON.stringify for
 * the local WS, AES-GCM seal for a relay). `canWrite` gates mutating frames.
 */
export interface GatewayPeer {
	readonly id: string;
	/** Display name (from the `hello` frame), used in notices/participants. */
	name: string;
	/** Whether this peer may send mutating frames. */
	canWrite: boolean;
	/** True if joined through a read-only link/profile. */
	readOnly: boolean;
	/** Whether this peer negotiated the rich control surface. */
	control: boolean;
	/** Deliver a frame to this peer. */
	send(frame: GatewayOutbound): void;
	/** Close the underlying connection. */
	close(reason?: string): void;
}
