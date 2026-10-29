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
 * Follows a simple type down to the built-in type it restricts.
 *
 * A union or a list has no single built-in type, and a type the schema names but does not define here is answered by
 * its own name.
 *
 * @param {string | undefined} typeName - A type name as written in the schema.
 * @param {ReturnType<typeof indexSchema>} index
 * @param {Set<string>} [seen] - Simple types already followed, so a restriction that refers back to itself ends.
 * @returns {string | undefined} The built-in type's name without its prefix, like `decimal`.
 */
function builtInTypeName(typeName, index, seen = new Set()) {
    const name = localName(typeName);
    if (!name) return undefined;
    const simpleType = index.simpleTypes.get(name);
    if (!simpleType) return name;
    if (seen.has(name)) return undefined;
    seen.add(name);
    return simpleTypeBase(simpleType, index, seen);
}

/**
 * @param {Object} simpleType - A `simpleType` node, named or inline.
 * @param {ReturnType<typeof indexSchema>} index
 * @param {Set<string>} [seen]
 * @returns {string | undefined}
 */
function simpleTypeBase(simpleType, index, seen = new Set()) {
    return builtInTypeName(simpleType.restriction?.[0]?.base, index, seen);
}

/**
 * Says whether a built-in type's values are held as numbers or booleans. Everything else is text.
 *
 * @param {string | undefined} builtInName - From `builtInTypeName`.
 * @returns {"number" | "boolean" | undefined}
 */
function kindOf(builtInName) {
    if (!builtInName) return undefined;
    if (NUMERIC_TYPES.has(builtInName)) return "number";
    if (builtInName === BOOLEAN_TYPE) return "boolean";
    return undefined;
}

/**
 * The most element paths one schema may describe. A type used in several places is walked once for each, so a few
 * kilobytes of nested, repeated types can describe millions of paths, and walking them blocks the server and can run
 * it out of memory. A real data model has a few thousand at most.
 */
const MAX_SCHEMA_PATHS = 100_000;

/**
 * Counts the paths a walk visits, and stops the walk once there are more than any data model has.
 *
 * @returns {() => void} Call once per path; it throws past the limit.
 */
function pathBudget() {
    let left = MAX_SCHEMA_PATHS;
    return () => {
        left -= 1;
        if (left < 0) throw new Error(`the schema describes more than ${MAX_SCHEMA_PATHS} element paths, more than any data model has`);
    };
}

/**
 * Collects the element and attribute declarations a complex type contributes, through its sequences, choices and
 * groups, and through the type it extends.
 *
 * @param {Object} complexType - A `complexType` node, named or inline.
 * @param {ReturnType<typeof indexSchema>} index
 * @param {Set<Object>} [basesOnPath] - The types already being collected further down, so a type that extends itself,
 *   directly or through others, ends rather than recursing until the stack runs out.
 * @returns {{ childElements: Object[], attributes: Object[], valueType: string | undefined }} The child element and
 *   attribute declarations, and for simple content (text with attributes), the built-in type of that text.
 */
function complexTypeContent(complexType, index, basesOnPath = new Set()) {
    if (basesOnPath.has(complexType)) return { childElements: [], attributes: [], valueType: undefined };
    const nextBasesOnPath = new Set(basesOnPath).add(complexType);
    const childElements = [];
    const attributes = [...(complexType.attribute ?? [])];
    let valueType;

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
        if (base) {
            const baseContent = complexTypeContent(base, index, nextBasesOnPath);
            childElements.push(...baseContent.childElements);
            attributes.push(...baseContent.attributes);
        }
        collectParticles(derivation);
        attributes.push(...(derivation.attribute ?? []));
    }

    const simpleContent = complexType.simpleContent?.[0];
    const simpleDerivation = simpleContent?.extension?.[0] ?? simpleContent?.restriction?.[0];
    if (simpleDerivation?.base) {
        const baseComplexType = index.complexTypes.get(localName(simpleDerivation.base));
        if (baseComplexType) {
            const baseContent = complexTypeContent(baseComplexType, index, nextBasesOnPath);
            valueType = baseContent.valueType;
            if (simpleContent.extension?.[0]) attributes.push(...baseContent.attributes);
        } else {
            valueType = builtInTypeName(simpleDerivation.base, index);
        }
    }
    attributes.push(...(simpleDerivation?.attribute ?? []));

    return { childElements, attributes, valueType };
}

/** The XSD elements that pull in another schema file by its `schemaLocation`. */
const SCHEMA_REFERENCE_ELEMENTS = new Set(["include", "import", "redefine", "override"]);

/**
 * Lists the other schema files an XSD pulls in through `include`, `import`, `redefine` or `override`.
 *
 * libxml2 reads each of those when the schema is compiled for validation, from wherever `schemaLocation` points,
 * including a path on this machine, and it reads them with entity substitution on. A schema from a repository could
 * therefore read local files, or hang the whole server on a blocking one such as `/dev/stdin`. The data models Altinn
 * Studio generates are self-contained, so any reference at all is a reason not to compile the schema.
 *
 * @param {string} xsdContent - The XSD schema content as a string.
 * @returns {string[]} The `schemaLocation` of every reference, in document order. Empty for a self-contained schema.
 */
export function externalSchemaReferences(xsdContent) {
    const locations = [];
    const visit = (node) => {
        if (Array.isArray(node)) {
            node.forEach(visit);
            return;
        }
        if (node === null || typeof node !== "object") return;
        for (const [key, value] of Object.entries(node)) {
            if (SCHEMA_REFERENCE_ELEMENTS.has(key)) {
                for (const reference of value) {
                    if (typeof reference?.schemaLocation === "string") locations.push(reference.schemaLocation);
                }
            }
            visit(value);
        }
    };
    visit(xsdParser.parse(xsdContent));
    return locations;
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
    const countPath = pathBudget();

    // typesOnPath holds the type nodes, not their names: an element that refers back to itself through its own inline
    // type has no type name to recognise, but it does arrive at the same node.
    const visit = (element, parentPath, typesOnPath) => {
        const declaration = element.ref ? index.elements.get(localName(element.ref)) : element;
        if (!declaration?.name) return;
        countPath();
        const path = parentPath ? `${parentPath}.${declaration.name}` : declaration.name;

        const typeName = localName(declaration.type);
        const complexType = declaration.complexType?.[0] ?? (typeName && index.complexTypes.get(typeName));
        if (complexType) {
            if (typesOnPath.has(complexType)) return;
            const nextTypesOnPath = new Set(typesOnPath).add(complexType);
            const { childElements, valueType } = complexTypeContent(complexType, index);
            const valueKind = kindOf(valueType);
            if (valueKind) kinds.set(path, valueKind);
            for (const child of childElements) visit(child, path, nextTypesOnPath);
            return;
        }

        const inlineSimpleType = declaration.simpleType?.[0];
        const kind = kindOf(inlineSimpleType ? simpleTypeBase(inlineSimpleType, index) : builtInTypeName(declaration.type, index));
        if (kind) kinds.set(path, kind);
    };

    for (const element of schemaNode.element ?? []) visit(element, "", new Set());
    return kinds;
}

/**
 * @typedef {Object} XsdField
 * @property {string} path - Dot-separated from below the root element, the way a layout's `dataModelBindings` name a
 *   field. An attribute is named like an element, as Altinn's data model holds it.
 * @property {"element" | "attribute"} node
 * @property {string | null} type - The built-in XSD type the value is held as, after following simple types (`string`,
 *   `decimal`). Null for an element that holds other elements, and for a union or a list.
 * @property {number} minOccurs - 0 for an optional attribute, 1 for a required one.
 * @property {number | "unbounded"} maxOccurs - Always 1 for an attribute.
 * @property {string} [fixed] - The value the schema fixes, as Altinn's models do for `dataFormatVersion`.
 */

/**
 * @param {string | undefined} value - A `minOccurs` or `maxOccurs` as written, absent meaning 1.
 * @returns {number | "unbounded"}
 */
function occurs(value) {
    return value === "unbounded" ? value : Number(value ?? "1");
}

/**
 * Lists every field an Altinn app's data model declares, so two apps' copies of the same model can be compared field by
 * field without ordering, annotations or formatting getting in the way.
 *
 * The root is the first top-level element, the one Altinn Studio generates; other top-level elements are only reached
 * through references. A field's occurrence is read where it is used, so a reference can make an element repeat that
 * does not repeat where it is declared. A type that contains itself is listed once per path and not followed further,
 * as in `extractValueKinds`.
 *
 * @param {string} xsdContent - The XSD schema content as a string.
 * @returns {{ rootElement: string | null, fields: XsdField[] }} The fields, parents before their children. The order
 *   within a type is not the schema's (a nested choice comes after its siblings), so compare them by path.
 */
export function extractFields(xsdContent) {
    const schemaNode = xsdParser.parse(xsdContent).schema?.[0];
    const root = schemaNode?.element?.find((element) => element.name);
    if (!root) return { rootElement: null, fields: [] };
    const index = indexSchema(schemaNode);
    const fields = [];
    const countPath = pathBudget();
    const join = (parentPath, name) => (parentPath ? `${parentPath}.${name}` : name);

    const visitAttributes = (attributes, parentPath) => {
        for (const attribute of attributes) {
            if (!attribute.name) continue;
            const inlineSimpleType = attribute.simpleType?.[0];
            fields.push({
                path: join(parentPath, attribute.name),
                node: "attribute",
                type: (inlineSimpleType ? simpleTypeBase(inlineSimpleType, index) : builtInTypeName(attribute.type, index)) ?? null,
                minOccurs: attribute.use === "required" ? 1 : 0,
                maxOccurs: 1,
                ...(attribute.fixed === undefined ? {} : { fixed: attribute.fixed })
            });
        }
    };

    const visitContent = (declaration, path, typesOnPath) => {
        const typeName = localName(declaration.type);
        const complexType = declaration.complexType?.[0] ?? (typeName && index.complexTypes.get(typeName));
        if (complexType) {
            // Type nodes rather than names, as in extractValueKinds, so a reference back through an inline type ends.
            if (typesOnPath.has(complexType)) return null;
            const nextTypesOnPath = new Set(typesOnPath).add(complexType);
            const { childElements, attributes, valueType } = complexTypeContent(complexType, index);
            visitAttributes(attributes, path);
            for (const child of childElements) visitElement(child, path, nextTypesOnPath);
            return valueType ?? null;
        }
        const inlineSimpleType = declaration.simpleType?.[0];
        return (inlineSimpleType ? simpleTypeBase(inlineSimpleType, index) : builtInTypeName(declaration.type, index)) ?? null;
    };

    const visitElement = (element, parentPath, typesOnPath) => {
        const declaration = element.ref ? index.elements.get(localName(element.ref)) : element;
        if (!declaration?.name) return;
        countPath();
        const field = {
            path: join(parentPath, declaration.name),
            node: "element",
            type: null,
            minOccurs: Number(element.minOccurs ?? "1"),
            maxOccurs: occurs(element.maxOccurs),
            ...(declaration.fixed === undefined ? {} : { fixed: declaration.fixed })
        };
        fields.push(field);
        field.type = visitContent(declaration, field.path, typesOnPath);
    };

    visitContent(root, "", new Set());
    return { rootElement: root.name, fields };
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
