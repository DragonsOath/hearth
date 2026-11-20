/**
 * Is this prompt about the homelab? Checked on every prompt in every
 * session, so it is plain matching with no network: well-known homelab
 * words (shared with Hearth), plus the names of your own projects,
 * machines, and services that the last briefing taught it.
 */
export { isHomelab } from "@dragon-control/core";
