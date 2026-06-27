/** React binding for {@link LocalClient} via `useSyncExternalStore`. */
import { useSyncExternalStore } from "react";
import type { LocalClient, LocalSnapshot } from "./local-client";

export function useLocalSnapshot(client: LocalClient): LocalSnapshot {
	return useSyncExternalStore(
		listener => client.subscribe(listener),
		() => client.getSnapshot(),
		() => client.getSnapshot(),
	);
}

/** Bootstrap config injected by the local web server into the SPA shell. */
export interface OmpWebConfig {
	profile: "local";
	wsPath: string;
	token: string;
}

/** Read the local-profile bootstrap, or null when served as the relay guest SPA. */
export function readOmpWebConfig(): OmpWebConfig | null {
	const config = window.__OMP_WEB;
	if (config?.profile !== "local") return null;
	return config;
}

/** Build the same-origin WebSocket URL from the injected config. */
export function localWsUrl(config: OmpWebConfig): string {
	const scheme = window.location.protocol === "https:" ? "wss" : "ws";
	return `${scheme}://${window.location.host}${config.wsPath}?token=${encodeURIComponent(config.token)}`;
}
