/**
 * Deterministic crypto primitives.
 *
 * Currently re-exports the Ed25519 signing API. Used by transport-level
 * signing (e.g. /peer-chat envelopes).
 */

export {
	type KeyPair,
	generateKeyPair,
	sign,
	verify,
} from "./ed25519.js";
