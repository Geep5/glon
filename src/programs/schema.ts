/**
 * Tiny JSON Schema validator — supports the subset used by typedActions:
 * `type` in {object, array, string, number, integer, boolean}, `required`,
 * `properties`, `items`. No `$ref`, `oneOf`, `enum`, format checks, etc.
 * If you need richer schemas, swap in ajv.
 */

export function validateSchema(value: unknown, schema: Record<string, unknown>, path = ""): string | null {
	if (schema.type === "object") {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return `${path || "root"} must be an object`;
		}
		const obj = value as Record<string, unknown>;
		const required = (schema.required as string[]) ?? [];
		for (const key of required) {
			if (!(key in obj)) {
				return `${path || "root"}.${key} is required`;
			}
		}
		const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
		if (props) {
			for (const [key, subSchema] of Object.entries(props)) {
				if (key in obj) {
					const err = validateSchema(obj[key], subSchema, `${path || "root"}.${key}`);
					if (err) return err;
				}
			}
		}
		return null;
	}
	if (schema.type === "array") {
		if (!Array.isArray(value)) {
			return `${path || "root"} must be an array`;
		}
		const itemSchema = schema.items as Record<string, unknown> | undefined;
		if (itemSchema) {
			for (let i = 0; i < value.length; i++) {
				const err = validateSchema(value[i], itemSchema, `${path || "root"}[${i}]`);
				if (err) return err;
			}
		}
		return null;
	}
	if (schema.type === "string") {
		if (typeof value !== "string") return `${path || "root"} must be a string`;
		return null;
	}
	if (schema.type === "number") {
		if (typeof value !== "number") return `${path || "root"} must be a number`;
		return null;
	}
	if (schema.type === "integer") {
		if (typeof value !== "number" || !Number.isInteger(value)) return `${path || "root"} must be an integer`;
		return null;
	}
	if (schema.type === "boolean") {
		if (typeof value !== "boolean") return `${path || "root"} must be a boolean`;
		return null;
	}
	return null;
}
