/**
 * Strips JavaScript-style line comments (`//`) from JSON content, ignoring `//` that appears inside strings.
 *
 * @param {string} jsonString - The JSON string potentially containing comments.
 * @returns {string} The JSON string with comments removed.
 */
export function stripJsonComments(jsonString) {
    return jsonString
        .split("\n")
        .map((line) => {
            // Find // that's not inside quotes
            let inQuotes = false;
            let commentStart = -1;

            for (let i = 0; i < line.length; i++) {
                if (line[i] === '"') {
                    // A quote is a real string delimiter only if preceded by an even number of backslashes.
                    let backslashes = 0;
                    for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) {
                        backslashes++;
                    }
                    if (backslashes % 2 === 0) {
                        inQuotes = !inQuotes;
                    }
                } else if (!inQuotes && line[i] === "/" && line[i + 1] === "/") {
                    commentStart = i;
                    break;
                }
            }

            if (commentStart >= 0) {
                return line.substring(0, commentStart).trimEnd();
            }
            return line;
        })
        .filter((line) => {
            const trimmed = line.trim();
            return !trimmed.startsWith("//");
        })
        .join("\n");
}
