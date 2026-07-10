// Serialize JSON without ever retaining more encoded text than `maxBytes`.
// Service handlers still materialize their result objects before this boundary,
// but an oversized result no longer creates an additional unbounded JSON string.
export function stringifyJsonWithinLimit(
  value: unknown,
  maxBytes: number,
): string | null | undefined {
  const chunks: string[] = [];
  let bytes = 0;

  const append = (chunk: string): boolean => {
    const chunkBytes = Buffer.byteLength(chunk);
    if (bytes + chunkBytes > maxBytes) return false;
    chunks.push(chunk);
    bytes += chunkBytes;
    return true;
  };

  const normalize = (current: unknown, key: string): unknown => {
    if (current !== null && typeof current === "object") {
      const toJSON = (current as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === "function") return toJSON.call(current, key);
    }
    return current;
  };

  const isOmitted = (current: unknown): boolean =>
    current === undefined ||
    typeof current === "function" ||
    typeof current === "symbol";

  const ancestors = new Set<object>();

  const writeString = (current: string): boolean => {
    // A JSON string is never shorter in UTF-8 than its unescaped value plus
    // the two quotes. Avoid allocating JSON.stringify(current) when that lower
    // bound already exceeds the remaining budget.
    if (Buffer.byteLength(current) + 2 > maxBytes - bytes) return false;
    return append(JSON.stringify(current));
  };

  const write = (
    input: unknown,
    key: string,
    alreadyNormalized = false,
  ): boolean => {
    const current = alreadyNormalized ? input : normalize(input, key);
    if (current === null) return append("null");

    switch (typeof current) {
      case "string":
        return writeString(current);
      case "number":
      case "boolean":
        return append(JSON.stringify(current));
      case "bigint":
        throw new TypeError("Do not know how to serialize a BigInt");
      case "undefined":
      case "function":
      case "symbol":
        throw new TypeError("Value is not JSON-serializable");
    }

    if (ancestors.has(current)) {
      throw new TypeError("Converting circular structure to JSON");
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (!append("[")) return false;
        for (let index = 0; index < current.length; index += 1) {
          if (index > 0 && !append(",")) return false;
          const item = normalize(current[index], String(index));
          if (isOmitted(item)) {
            if (!append("null")) return false;
          } else if (!write(item, String(index), true)) {
            return false;
          }
        }
        return append("]");
      }

      if (!append("{")) return false;
      let wroteProperty = false;
      for (const property of Object.keys(current)) {
        const propertyValue = normalize(
          (current as Record<string, unknown>)[property],
          property,
        );
        if (isOmitted(propertyValue)) continue;
        if (wroteProperty && !append(",")) return false;
        if (!writeString(property) || !append(":")) return false;
        if (!write(propertyValue, property, true)) return false;
        wroteProperty = true;
      }
      return append("}");
    } finally {
      ancestors.delete(current);
    }
  };

  const root = normalize(value, "");
  if (isOmitted(root)) return undefined;
  return write(root, "", true) ? chunks.join("") : null;
}
