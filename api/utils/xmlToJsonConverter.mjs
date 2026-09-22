// Dependencies
import { XMLParser } from "fast-xml-parser";
import libxml from "libxmljs2";

/**
 * Extracts the dot-separated paths of all elements in an XSD document that are defined as arrays.
 * An element is considered an array if its `maxOccurs` attribute is set to "unbounded" or a value greater than 1.
 *
 * @param {Object} xsdDoc - The parsed XSD document, expected to support XPath queries and element traversal.
 * @returns {Set<string>} A set of dot-separated string paths representing the location of array elements in the schema.
 */
function extractArrayPaths(xsdDoc) {
    const arrayPaths = new Set();
    const elements = xsdDoc.find("//*[local-name()='element' and (@maxOccurs='unbounded' or number(@maxOccurs) > 1)]");
    for (const el of elements) {
        const path = [];
        let current = el;
        while (current) {
            if (current.name() === "element" && current.attr("name")) {
                path.unshift(current.attr("name").value());
            }
            current = current.parent();
            if (!current || current.name() === "schema") break;
        }
        if (path.length) {
            arrayPaths.add(path.join("."));
        }
    }
    return arrayPaths;
}

/**
 * @typedef {Object} CompiledXmlSchema
 * @property {Object} document - The parsed XSD, reused for every file validated against it.
 * @property {string[]} arrayPaths - Dot-separated paths of the elements the schema allows more than one of.
 */

/**
 * Parses an XSD once, so the files validated against it don't each pay for it.
 *
 * A data type's examples all share one schema, and parsing it is the expensive half of the work: an app with eight
 * examples used to parse the same XSD eight times and walk it eight times looking for `maxOccurs`. Separating the
 * schema from the file means that happens once per data type instead of once per file.
 *
 * The parsed document is reused across validations, which is safe — validating reads the schema, it does not consume
 * it. It holds native memory for as long as it is referenced, so callers should let it go once their files are done
 * rather than keeping it around.
 *
 * @param {string} xsdContent - The XSD schema content as a string.
 * @returns {CompiledXmlSchema} The schema, ready to validate against.
 * @throws {Error} If the XSD itself cannot be parsed.
 */
export function compileXmlSchema(xsdContent) {
    const document = libxml.parseXml(xsdContent);
    return { document, arrayPaths: [...extractArrayPaths(document)] };
}

/**
 * Converts XML content to JSON, validating against an already-parsed XSD schema.
 *
 * @param {string} xmlContent - The XML content as a string.
 * @param {CompiledXmlSchema} schema - The schema to validate against, from `compileXmlSchema`.
 * @returns {Object} The JSON representation of the XML, with the root element removed.
 *
 * @throws {Error} If the XML does not conform to the XSD schema. The message lists one validation error per line.
 */
export function convertXmlToJson(xmlContent, schema) {
    const xmlDoc = libxml.parseXml(xmlContent);

    // Validate XML. This converter has no idea which app or file it was handed, so it stays silent and reports through
    // the thrown error — the caller knows the context and records it (see api/utils/logger.mjs).
    if (!xmlDoc.validate(schema.document)) {
        // One error per line: the logger indents multi-line details under the file they belong to.
        const validationMessages = xmlDoc.validationErrors.map((e) => e.message.trim()).join("\n");
        // Throw instead of process.exit so a single invalid example doesn't take down the whole dev server.
        throw new Error(`XML does not conform to XSD:\n${validationMessages}`);
    }

    const arrayPathList = schema.arrayPaths;

    const parser = new XMLParser({
        ignoreAttributes: true,
        attributeNamePrefix: "@",
        parseTagValue: true,
        parseAttributeValue: true,
        trimValues: true,

        isArray: (tagName, jpath) => {
            // Example jpath: Order.Item or Order.Item.Sku
            const normalized = jpath.replace(/\.@.*$/, "").split(".");

            return arrayPathList.some((xsdPath) => {
                const xsdParts = xsdPath.split(".");
                if (xsdParts.length > normalized.length) return false;

                // compare suffix
                for (let i = 1; i <= xsdParts.length; i++) {
                    if (xsdParts[xsdParts.length - i] !== normalized[normalized.length - i]) {
                        return false;
                    }
                }
                return true;
            });
        }
    });

    const parsed = parser.parse(xmlContent);

    // Remove the top-level/root element. Skip the "?xml" declaration key rather than assuming it is always at index 0,
    // so files without an <?xml ?> declaration still resolve the correct root element.
    const rootKey = Object.keys(parsed).find((key) => key !== "?xml");
    const jsonWithoutRoot = parsed[rootKey];

    return jsonWithoutRoot;
}
