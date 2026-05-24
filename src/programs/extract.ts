/**
 * Field extractors — pull plain JS values out of proto fields that may be
 * either raw primitives or Value wrappers (the wire shape varies depending
 * on whether the caller used `stringVal`/`mapVal` helpers or constructed
 * the message directly).
 *
 * Used by the program loader to read manifest fields off `program` objects
 * without caring how they were encoded.
 */

/** Extract a plain string from a proto field (raw string or Value wrapper). */
export function extractString(field: unknown): string | undefined {
	if (field == null) return undefined;
	if (typeof field === "string") return field;
	if (typeof field === "object" && "stringValue" in (field as any)) {
		return (field as any).stringValue as string;
	}
	return undefined;
}

/** Extract a commands map from a field (plain object or proto ValueMap). */
export function extractCommands(field: unknown): Record<string, string> {
	if (field == null) return {};
	if (typeof field === "object" && "mapValue" in (field as any)) {
		const entries = (field as any).mapValue?.entries;
		if (!entries || typeof entries !== "object") return {};
		const result: Record<string, string> = {};
		for (const [key, val] of Object.entries(entries)) {
			const s = extractString(val);
			if (s !== undefined) result[key] = s;
		}
		return result;
	}
	if (typeof field === "object") {
		const result: Record<string, string> = {};
		for (const [key, val] of Object.entries(field as Record<string, unknown>)) {
			const s = typeof val === "string" ? val : extractString(val);
			if (s !== undefined) result[key] = s;
		}
		return result;
	}
	return {};
}

/** Extract a string→string map from a ValueMap field. */
export function extractStringMap(field: unknown): Map<string, string> {
	const result = new Map<string, string>();
	if (field == null) return result;
	if (typeof field === "object" && "mapValue" in (field as any)) {
		const entries = (field as any).mapValue?.entries;
		if (entries && typeof entries === "object") {
			for (const [key, val] of Object.entries(entries)) {
				const s = extractString(val);
				if (s !== undefined) result.set(key, s);
			}
		}
	}
	return result;
}
