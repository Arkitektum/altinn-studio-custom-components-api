import assert from "node:assert/strict";
import { test } from "node:test";

import { extractValueKinds, typedValue } from "./xsdValueTypes.mjs";

/**
 * Shaped like the schemas Altinn Studio generates: one root element typed by a named complex type, the rest declared
 * as named types and referred to by name, a simple type restricting a built-in one, and an extension.
 */
const XSD = `<?xml version="1.0" encoding="utf-8"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:tns="urn:test" targetNamespace="urn:test" elementFormDefault="qualified">
    <xsd:element name="Soeknad" type="tns:SoeknadType" />
    <xsd:complexType name="SoeknadType">
        <xsd:sequence>
            <xsd:element name="eiendom" type="tns:EiendomType" minOccurs="0" maxOccurs="unbounded" />
            <xsd:element name="fraSluttbrukersystem" type="xsd:string" />
            <xsd:element name="erTiltakshaver" type="xsd:boolean" minOccurs="0" />
            <xsd:element name="arealBYA" type="tns:ArealType" minOccurs="0" />
            <xsd:element name="antallEtasjer" minOccurs="0">
                <xsd:simpleType>
                    <xsd:restriction base="xsd:int" />
                </xsd:simpleType>
            </xsd:element>
            <xsd:choice>
                <xsd:element name="tiltakshaver" type="tns:PartType" />
                <xsd:element name="ansvarligSoeker" type="tns:PartType" />
            </xsd:choice>
            <xsd:element ref="tns:merknad" minOccurs="0" />
            <xsd:element name="beloep" type="tns:BeloepType" minOccurs="0" />
        </xsd:sequence>
    </xsd:complexType>
    <xsd:element name="merknad" type="xsd:decimal" />
    <xsd:complexType name="EiendomType">
        <xsd:sequence>
            <xsd:element name="kommunenummer" type="xsd:string" />
            <xsd:element name="gaardsnummer" type="xsd:integer" />
            <xsd:element name="postnr" type="tns:PostnummerType" />
            <xsd:element name="eier" type="tns:PartType" minOccurs="0" />
        </xsd:sequence>
    </xsd:complexType>
    <xsd:complexType name="PartType">
        <xsd:sequence>
            <xsd:element name="navn" type="xsd:string" />
            <xsd:element name="telefonnummer" type="xsd:string" minOccurs="0" />
            <xsd:element name="antallAnsatte" type="xsd:nonNegativeInteger" minOccurs="0" />
        </xsd:sequence>
    </xsd:complexType>
    <xsd:complexType name="UtvidetPartType">
        <xsd:complexContent>
            <xsd:extension base="tns:PartType">
                <xsd:sequence>
                    <xsd:element name="erPrivatperson" type="xsd:boolean" />
                </xsd:sequence>
            </xsd:extension>
        </xsd:complexContent>
    </xsd:complexType>
    <xsd:complexType name="BeloepType">
        <xsd:simpleContent>
            <xsd:extension base="xsd:decimal">
                <xsd:attribute name="valuta" type="xsd:string" />
            </xsd:extension>
        </xsd:simpleContent>
    </xsd:complexType>
    <xsd:simpleType name="ArealType">
        <xsd:restriction base="tns:DesimalType">
            <xsd:minInclusive value="0" />
        </xsd:restriction>
    </xsd:simpleType>
    <xsd:simpleType name="DesimalType">
        <xsd:restriction base="xsd:decimal" />
    </xsd:simpleType>
    <xsd:simpleType name="PostnummerType">
        <xsd:restriction base="xsd:string">
            <xsd:pattern value="[0-9]{4}" />
        </xsd:restriction>
    </xsd:simpleType>
</xsd:schema>`;

test("types an element by the built-in type it is declared with", () => {
    const kinds = extractValueKinds(XSD);

    assert.equal(kinds.get("Soeknad.erTiltakshaver"), "boolean");
    assert.equal(kinds.get("Soeknad.eiendom.gaardsnummer"), "number");
});

test("leaves text elements out, so a kommunenummer or a postnummer keeps its leading zero", () => {
    const kinds = extractValueKinds(XSD);

    assert.equal(kinds.has("Soeknad.fraSluttbrukersystem"), false);
    assert.equal(kinds.has("Soeknad.eiendom.kommunenummer"), false);
    // A simple type restricting xs:string with a digits-only pattern is still text.
    assert.equal(kinds.has("Soeknad.eiendom.postnr"), false);
});

test("follows a simple type through the restrictions it is built on", () => {
    const kinds = extractValueKinds(XSD);

    // ArealType restricts DesimalType, which restricts xs:decimal.
    assert.equal(kinds.get("Soeknad.arealBYA"), "number");
    // Inline simple type.
    assert.equal(kinds.get("Soeknad.antallEtasjer"), "number");
});

test("gives a named complex type's elements a path under every element that uses it", () => {
    const kinds = extractValueKinds(XSD);

    assert.equal(kinds.get("Soeknad.tiltakshaver.antallAnsatte"), "number");
    assert.equal(kinds.get("Soeknad.ansvarligSoeker.antallAnsatte"), "number");
    assert.equal(kinds.get("Soeknad.eiendom.eier.antallAnsatte"), "number");
    assert.equal(kinds.has("Soeknad.tiltakshaver.telefonnummer"), false);
});

test("follows an element reference to the top-level element it names", () => {
    assert.equal(extractValueKinds(XSD).get("Soeknad.merknad"), "number");
});

test("types the text of an element with simple content by the type it extends", () => {
    assert.equal(extractValueKinds(XSD).get("Soeknad.beloep"), "number");
});

test("includes the elements a complex type inherits by extension", () => {
    const xsd = XSD.replace(
        '<xsd:element name="tiltakshaver" type="tns:PartType" />',
        '<xsd:element name="tiltakshaver" type="tns:UtvidetPartType" />'
    );

    const kinds = extractValueKinds(xsd);

    assert.equal(kinds.get("Soeknad.tiltakshaver.erPrivatperson"), "boolean");
    assert.equal(kinds.get("Soeknad.tiltakshaver.antallAnsatte"), "number");
});

test("stops at a type that contains itself rather than recursing forever", () => {
    const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
    <xs:element name="rot" type="NodeType" />
    <xs:complexType name="NodeType">
        <xs:sequence>
            <xs:element name="verdi" type="xs:int" />
            <xs:element name="barn" type="NodeType" minOccurs="0" maxOccurs="unbounded" />
        </xs:sequence>
    </xs:complexType>
</xs:schema>`;

    const kinds = extractValueKinds(xsd);

    assert.equal(kinds.get("rot.verdi"), "number");
    assert.equal(kinds.has("rot.barn.verdi"), false);
});

test("answers an empty map for something that is not a schema", () => {
    assert.equal(extractValueKinds("<ikke-et-skjema />").size, 0);
});

test("turns a number's text into a number, leading zeros and all, as the data model does", () => {
    assert.equal(typedValue("0150", "number"), 150);
    assert.equal(typedValue("60.10", "number"), 60.1);
    assert.equal(typedValue("-3", "number"), -3);
});

test("leaves a number's text alone when it does not read as a finite number", () => {
    assert.equal(typedValue("INF", "number"), "INF");
    assert.equal(typedValue("NaN", "number"), "NaN");
    assert.equal(typedValue("", "number"), "");
});

test("reads all four spellings of an XSD boolean", () => {
    assert.equal(typedValue("true", "boolean"), true);
    assert.equal(typedValue("1", "boolean"), true);
    assert.equal(typedValue("false", "boolean"), false);
    assert.equal(typedValue("0", "boolean"), false);
    assert.equal(typedValue("ja", "boolean"), "ja");
});

test("leaves text as text", () => {
    assert.equal(typedValue("0301", undefined), "0301");
    assert.equal(typedValue("+4722334455", undefined), "+4722334455");
});
