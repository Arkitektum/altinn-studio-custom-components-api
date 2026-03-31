export default {
    $schema: "https://altinncdn.no/toolkits/altinn-app-frontend/4/schemas/json/layout/layout.schema.v1.json",
    data: {
        layout: [
            {
                id: "custom-dispensasjon",
                type: "Custom",
                tagName: "custom-dispensasjon",
                dataModelBindings: {
                    begrunnelse: {
                        dataType: "DispensasjonssoeknadDataV1",
                        field: "begrunnelse"
                    },
                    bestemmelsestype: {
                        dataType: "DispensasjonssoeknadDataV1",
                        field: "bestemmelsestype"
                    },
                    dispensasjonsbeskrivelse: {
                        dataType: "DispensasjonssoeknadDataV1",
                        field: "dispensasjonsbeskrivelse"
                    },
                    dispensasjonsreferanse: {
                        dataType: "DispensasjonssoeknadDataV1",
                        field: "dispensasjonsreferanse"
                    },
                    dispensasjonstema: {
                        dataType: "DispensasjonssoeknadDataV1",
                        field: "dispensasjonstema"
                    },
                    eiendomByggested: {
                        dataType: "DS",
                        field: "eiendomByggested"
                    },
                    generelleVilkaar: {
                        dataType: "DS",
                        field: "generelleVilkaar"
                    },
                    kommunensSaksnummer: {
                        dataType: "DS",
                        field: "kommunensSaksnummer"
                    },
                    metadata: {
                        dataType: "DS",
                        field: "metadata"
                    },
                    nasjonalArealplanId: {
                        dataType: "DispensasjonssoeknadDataV1",
                        field: "nasjonalArealplanId"
                    },
                    paragrafnummer: {
                        dataType: "DispensasjonssoeknadDataV1",
                        field: "paragrafnummer"
                    },
                    plannavn: {
                        dataType: "DispensasjonssoeknadDataV1",
                        field: "plannavn"
                    },
                    stedfesting: {
                        dataType: "DispensasjonssoeknadDataV1",
                        field: "stedfesting"
                    },
                    tiltakshaver: {
                        dataType: "DS",
                        field: "tiltakshaver"
                    },
                    tiltakstyper: {
                        dataType: "DispensasjonssoeknadDataV1",
                        field: "tiltakstyper"
                    },
                    varighet: {
                        dataType: "DispensasjonssoeknadDataV1",
                        field: "varighet"
                    }
                }
            }
        ]
    }
};
