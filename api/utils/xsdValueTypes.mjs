// Dependencies
import { XMLParser } from "fast-xml-parser";

/**
 * Built-in XSD types whose values an Altinn app's data model holds as numbers. Everything else, `xs:string` above all,
 * is held as text, which is what keeps a kommunenummer like `0301` or a postnummer like `0150` intact.
 */
const NUMERIC_TYPES = new Set([
    "decimal",
    "integer",
    "int",
    "long",
    "short",
    "byte",
    "nonNegativeInteger",
    "positiveInteger",
    "negativeInteger",
    "nonPositiveInteger",
    "unsignedLong",
    "unsignedInt",
    "unsignedShort",
    "unsignedByte",
    "double",
    "float"
]);

const BOOLEAN_TYPE = "boolean";

/**
 * Reads an XSD into a plain tree, every child element as an array and attributes as plain properties.
 *
 * Namespace prefixes are dropped from element names so `xs:element` and `xsd:element` read the same. Attribute values
 * keep theirs (`type="xs:decimal"`), which `localName` strips where a type is looked up.
 */
const xsdParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    removeNSPrefix: true,
    parseAttributeValue: false,
    isArray: (_tagName, _jpath, _isLeafNode, isAttribute) => !isAttribute
});

/**
 * @param {string | undefined} qualifiedName - A name that may carry a namespace prefix, like `xs:decimal`.
 * @returns {string | undefined} The name without its prefix.
 */
function localName(qualifiedName) {
    return qualifiedName?.split(":").pop();
}

/**
 * Indexes a schema's top-level elements, complex types and simple types by name.
 *
 * @param {Object} schemaNode - The parsed `schema` element.
 * @returns {{ elements: Map<string, Object>, complexTypes: Map<string, Object>, simpleTypes: Map<string, Object> }}
 */
function indexSchema(schemaNode) {
    const byName = (nodes) => new Map((nodes ?? []).filter((node) => node.name).map((node) => [node.name, node]));
    return {
        elements: byName(schemaNode.element),
        complexTypes: byName(schemaNode.complexType),
        simpleTypes: byName(schemaNode.simpleType)
    };
}

/**
 * Follows a simple type down to the built-in type it restricts, and says whether that is a number or a boolean.
 *
 * A union or a list is text as far as the data model is concerned, and so is a type the schema names but does not
 * define here.
 *
 * @param {string | undefined} typeName - A type name as written in the schema.
 * @param {ReturnType<typeof indexSchema>} index
 * @param {Set<string>} [seen] - Simple types already followed, so a restriction that refers back to itself ends.
 * @returns {"number" | "boolean" | undefined}
 */
function builtInKind(typeName, index, seen = new Set()) {
    const name = localName(typeName);
    if (!name) return undefined;
    const simpleType = index.simpleTypes.get(name);
    if (simpleType) {
        if (seen.has(name)) return undefined;
        seen.add(name);
        return simpleTypeKind(simpleType, index, seen);
    }
    if (NUMERIC_TYPES.has(name)) return "number";
    if (name === BOOLEAN_TYPE) return "boolean";
    return undefined;
}

/**
 * @param {Object} simpleType - A `simpleType` node, named or inline.
 * @param {ReturnType<typeof indexSchema>} index
 * @param {Set<string>} seen
 * @returns {"number" | "boolean" | undefined}
 */
function simpleTypeKind(simpleType, index, seen) {
    return builtInKind(simpleType.restriction?.[0]?.base, index, seen);
}

/**
 * Collects the element declarations a complex type contributes, through its sequences, choices and groups, and through
 * the type it extends.
 *
 * @param {Object} complexType - A `complexType` node, named or inline.
 * @param {ReturnType<typeof indexSchema>} index
 * @returns {{ childElements: Object[], valueKind: "number" | "boolean" | undefined }} The child element declarations,
 *   and for simple content (text with attributes), the kind of that text.
 */
function complexTypeContent(complexType, index) {
    const childElements = [];
    let valueKind;

    const collectParticles = (node) => {
        for (const particle of ["sequence", "choice", "all"]) {
            for (const group of node[particle] ?? []) {
                childElements.push(...(group.element ?? []));
                collectParticles(group);
            }
        }
    };

    collectParticles(complexType);

    const complexContent = complexType.complexContent?.[0];
    const derivation = complexContent?.extension?.[0] ?? complexContent?.restriction?.[0];
    if (derivation) {
        // A restriction restates the content it keeps, so only an extension inherits its base's elements.
        const base = complexContent.extension?.[0] && index.complexTypes.get(localName(derivation.base));
        if (base) childElements.push(...complexTypeContent(base, index).childElements);
        collectParticles(derivation);
    }

    const simpleContent = complexType.simpleContent?.[0];
    const simpleDerivation = simpleContent?.extension?.[0] ?? simpleContent?.restriction?.[0];
    if (simpleDerivation?.base) {
        const baseComplexType = index.complexTypes.get(localName(simpleDerivation.base));
        valueKind = baseComplexType ? complexTypeContent(baseComplexType, index).valueKind : builtInKind(simpleDerivation.base, index);
    }

    return { childElements, valueKind };
}

/**
 * Reads, from an XSD, which element paths an Altinn app's data model holds as numbers or booleans.
 *
 * The paths are dot-separated and start at the root element, which is how fast-xml-parser reports a value's `jpath`,
 * so the converter can look each value up as it is parsed. Every element not listed holds text and is left as written.
 *
 * Named types are followed wherever they are used, so an element typed by a complex type declared elsewhere in the
 * schema contributes its paths under each element that uses it. A type that contains itself, directly or further down,
 * is followed once per path and then stopped.
 *
 * @param {string} xsdContent - The XSD schema content as a string.
 * @returns {Map<string, "number" | "boolean">} The kind of every element path that does not hold text.
 */
export function extractValueKinds(xsdContent) {
    const schemaNode = xsdParser.parse(xsdContent).schema?.[0];
    const kinds = new Map();
    if (!schemaNode) return kinds;
    const index = indexSchema(schemaNode);

    const visit = (element, parentPath, typesOnPath) => {
        const declaration = element.ref ? index.elements.get(localName(element.ref)) : element;
        if (!declaration?.name) return;
        const path = parentPath ? `${parentPath}.${declaration.name}` : declaration.name;

        const typeName = localName(declaration.type);
        const complexType = declaration.complexType?.[0] ?? (typeName && index.complexTypes.get(typeName));
        if (complexType) {
            if (typeName && typesOnPath.has(typeName)) return;
            const nextTypesOnPath = typeName ? new Set(typesOnPath).add(typeName) : typesOnPath;
            const { childElements, valueKind } = complexTypeContent(complexType, index);
            if (valueKind) kinds.set(path, valueKind);
            for (const child of childElements) visit(child, path, nextTypesOnPath);
            return;
        }

        const inlineSimpleType = declaration.simpleType?.[0];
        const kind = inlineSimpleType ? simpleTypeKind(inlineSimpleType, index, new Set()) : builtInKind(declaration.type, index);
        if (kind) kinds.set(path, kind);
    };

    for (const element of schemaNode.element ?? []) visit(element, "", new Set());
    return kinds;
}

/**
 * Turns an element's text into the value its data model holds.
 *
 * A value that does not read as its declared kind is left as text rather than turned into `NaN` or a wrong boolean.
 * The schema has already been validated against by the time this runs, so that only happens for `INF` and `NaN`.
 *
 * @param {string} text - The element's text, already trimmed.
 * @param {"number" | "boolean" | undefined} kind - The element's kind, from `extractValueKinds`.
 * @returns {string | number | boolean} The typed value, or the text unchanged.
 */
export function typedValue(text, kind) {
    if (kind === "number") {
        const number = Number(text);
        return text !== "" && Number.isFinite(number) ? number : text;
    }
    if (kind === "boolean") {
        if (text === "true" || text === "1") return true;
        if (text === "false" || text === "0") return false;
    }
    return text;
}
