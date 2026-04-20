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
 * Converts XML content to JSON, validating against a provided XSD schema.
 * Extracts array paths from the XSD to ensure correct array handling in the resulting JSON.
 *
 * @param {string} xmlContent - The XML content as a string.
 * @param {string} xsdContent - The XSD schema content as a string.
 * @returns {Object} The JSON representation of the XML, with the root element removed.
 *
 * @throws Will exit the process if the XML does not conform to the XSD schema.
 */
export function convertXmlToJson(xmlContent, xsdContent) {
    const xmlDoc = libxml.parseXml(xmlContent);
    const xsdDoc = libxml.parseXml(xsdContent);

    // Validate XML
    if (!xmlDoc.validate(xsdDoc)) {
        console.error("❌ XML does not conform to XSD:");
        xmlDoc.validationErrors.forEach((e) => console.error(e.message));
        process.exit(1);
    }

    console.log("✅ XML valid against XSD");

    const arrayPaths = extractArrayPaths(xsdDoc);

    // XML → JSON parser
    const arrayPathList = [...arrayPaths];

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

    // Remove the top-level/root element
    const rootKey = Object.keys(parsed)[1];
    const jsonWithoutRoot = parsed[rootKey];

    return jsonWithoutRoot;
}
