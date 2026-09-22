import assert from "node:assert/strict";
import { test } from "node:test";

import { compileXmlSchema, convertXmlToJson } from "./xmlToJsonConverter.mjs";

/**
 * A schema shaped like the ones the apps actually ship: a root element wrapping a scalar, a repeating complex
 * element, and a repeating scalar with a numeric bound rather than "unbounded".
 */
const XSD = `<?xml version="1.0" encoding="utf-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" elementFormDefault="qualified">
    <xs:element name="skjema">
        <xs:complexType>
            <xs:sequence>
                <xs:element name="tittel" type="xs:string" />
                <xs:element name="vedlegg" maxOccurs="unbounded">
                    <xs:complexType>
                        <xs:sequence>
                            <xs:element name="filnavn" type="xs:string" />
                        </xs:sequence>
                    </xs:complexType>
                </xs:element>
                <xs:element name="merknad" type="xs:string" minOccurs="0" maxOccurs="3" />
            </xs:sequence>
        </xs:complexType>
    </xs:element>
</xs:schema>`;

/**
 * An example that validates against XSD.
 *
 * @param {Object} options
 * @param {string} [options.tittel]
 * @param {string[]} [options.vedlegg] - One `<vedlegg>` per file name.
 * @param {string[]} [options.merknader]
 * @param {boolean} [options.declaration=true] - Whether to write the `<?xml ?>` declaration.
 * @returns {string}
 */
function xml({ tittel = "Tittel", vedlegg = ["a.pdf"], merknader = [], declaration = true } = {}) {
    const body = [
        `<tittel>${tittel}</tittel>`,
        ...vedlegg.map((filnavn) => `<vedlegg><filnavn>${filnavn}</filnavn></vedlegg>`),
        ...merknader.map((merknad) => `<merknad>${merknad}</merknad>`)
    ].join("");
    return `${declaration ? '<?xml version="1.0" encoding="utf-8"?>' : ""}<skjema>${body}</skjema>`;
}

test("converts XML to JSON with the root element removed", () => {
    const schema = compileXmlSchema(XSD);

    const data = convertXmlToJson(xml({ tittel: "Søknad om tillatelse" }), schema);

    // The root is stripped: what comes back is the form's contents, not a single-key wrapper around them.
    assert.equal(data.tittel, "Søknad om tillatelse");
    assert.equal(Object.hasOwn(data, "skjema"), false);
});

test("finds the root element in a file with no XML declaration", () => {
    const schema = compileXmlSchema(XSD);

    const data = convertXmlToJson(xml({ tittel: "Uten deklarasjon", declaration: false }), schema);

    assert.equal(data.tittel, "Uten deklarasjon");
});

test("keeps a repeating element as an array even when it occurs once", () => {
    // The whole point of reading maxOccurs out of the schema: the dashboard renders vedlegg as a list, and a list of
    // one must not arrive shaped differently from a list of two.
    const schema = compileXmlSchema(XSD);

    const data = convertXmlToJson(xml({ vedlegg: ["a.pdf"] }), schema);

    assert.deepEqual(data.vedlegg, [{ filnavn: "a.pdf" }]);
});

test("keeps a repeating element as an array when it occurs several times", () => {
    const schema = compileXmlSchema(XSD);

    const data = convertXmlToJson(xml({ vedlegg: ["a.pdf", "b.pdf"] }), schema);

    assert.deepEqual(data.vedlegg, [{ filnavn: "a.pdf" }, { filnavn: "b.pdf" }]);
});

test("reads a numeric maxOccurs as repeating, not only 'unbounded'", () => {
    const schema = compileXmlSchema(XSD);

    const data = convertXmlToJson(xml({ merknader: ["Første"] }), schema);

    assert.deepEqual(data.merknad, ["Første"]);
});

test("leaves an element the schema allows only once as a scalar", () => {
    const schema = compileXmlSchema(XSD);

    const data = convertXmlToJson(xml({ tittel: "Enkel" }), schema);

    assert.equal(data.tittel, "Enkel");
    assert.equal(Array.isArray(data.tittel), false);
    // Nested inside a repeating element, but not repeating itself.
    assert.equal(Array.isArray(data.vedlegg[0].filnavn), false);
});

test("throws, naming the validation errors, when the XML does not match the schema", () => {
    const schema = compileXmlSchema(XSD);
    const invalid = '<?xml version="1.0" encoding="utf-8"?><skjema><ukjentFelt>nei</ukjentFelt></skjema>';

    assert.throws(() => convertXmlToJson(invalid, schema), /XML does not conform to XSD/);
});

test("throws rather than returning half a document when the XML is malformed", () => {
    const schema = compileXmlSchema(XSD);

    assert.throws(() => convertXmlToJson("<skjema><tittel>ikke lukket", schema));
});

test("throws when the schema itself is not a schema", () => {
    assert.throws(() => compileXmlSchema("this is not a schema"));
});

test("reuses one compiled schema across files, including after one of them fails", () => {
    // The schema is parsed once per data type and handed to every file in the set, so validating must not consume or
    // disturb it — and one invalid example must not spoil the files after it.
    const schema = compileXmlSchema(XSD);
    const invalid = '<?xml version="1.0" encoding="utf-8"?><skjema><ukjentFelt>nei</ukjentFelt></skjema>';

    assert.equal(convertXmlToJson(xml({ tittel: "Første" }), schema).tittel, "Første");
    assert.throws(() => convertXmlToJson(invalid, schema), /XML does not conform to XSD/);
    assert.equal(convertXmlToJson(xml({ tittel: "Tredje" }), schema).tittel, "Tredje");
    assert.deepEqual(convertXmlToJson(xml({ vedlegg: ["c.pdf"] }), schema).vedlegg, [{ filnavn: "c.pdf" }]);
});

test("reports the array paths it found, so a schema is scanned once rather than once per file", () => {
    const schema = compileXmlSchema(XSD);

    // Dot-separated and rooted at the top-level element, which is how the parser's jpath arrives for comparison.
    assert.deepEqual([...schema.arrayPaths].sort(), ["skjema.merknad", "skjema.vedlegg"]);
});
