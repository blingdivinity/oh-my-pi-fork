/**
 * Internal URL routing system for internal protocols like agent://, memory://,
 * skill://, mcp://, local://, and xd://.
 *
 * The shared router contains stateless handlers. Session-bound resources such
 * as skills, rules, MCP connections, and local roots arrive through each
 * resolve call's `ResolveContext`; handlers never retain active-session state.
 */

export * from "./agent-protocol";
export * from "./artifact-protocol";
export * from "./history-protocol";
export * from "./issue-pr-protocol";
export * from "./json-query";
export * from "./local-protocol";
export * from "./mcp-protocol";
export * from "./memory-protocol";
export * from "./omp-protocol";
export * from "./parse";
export * from "./router";
export * from "./rule-protocol";
export * from "./skill-protocol";
export * from "./ssh-protocol";
export type * from "./types";
export * from "./vault-protocol";
export * from "./xd-protocol";
