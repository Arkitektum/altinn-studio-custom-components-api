export default {
    $schema: "https://altinncdn.no/toolkits/altinn-app-frontend/4/schemas/json/layout/layout.schema.v1.json",
    data: {
        layout: [
            {
                id: "custom-dispensasjon",
                type: "Custom",
                tagName: "custom-dispensasjon",
                dataModelBindings: {
                    dispensasjonBeskrivelse: {
                        dataType: "DispensasjonssoeknadDataV1",
                        field: "dispensasjonBeskrivelse"
                    },
                    dispensasjonReferanse: {
                        dataType: "DispensasjonssoeknadDataV1",
                        field: "dispensasjonReferanse"
                    },
                    soeknadstype: {
                        dataType: "DispensasjonssoeknadDataV1",
                        field: "soeknadstype"
                    },
                    kommunensSaksnummer: {
                        dataType: "ES",
                        field: "kommunensSaksnummer"
                    },
                    metadata: {
                        dataType: "ES",
                        field: "metadata"
                    },
                    tiltakshaver: {
                        dataType: "ES",
                        field: "tiltakshaver"
                    },
                    eiendomByggested: {
                        dataType: "ES",
                        field: "eiendomByggested"
                    },
                    tiltakstyper: {
                        dataType: "DispensasjonssoeknadDataV1",
                        field: "tiltakstyper"
                    },
                    dispensasjonFra: {
                        dataType: "DispensasjonssoeknadDataV1",
                        field: "dispensasjonFra"
                    },
                    stedfesting: {
                        dataType: "DispensasjonssoeknadDataV1",
                        field: "stedfesting"
                    },
                    varighet: {
                        dataType: "DispensasjonssoeknadDataV1",
                        field: "varighet"
                    },
                    begrunnelse: {
                        dataType: "DispensasjonssoeknadDataV1",
                        field: "begrunnelse"
                    },
                    generelleVilkaar: {
                        dataType: "ES",
                        field: "generelleVilkaar"
                    },
                    dispensasjonPlanBestemmelse: {
                        dataType: "DispensasjonssoeknadDataV1",
                        field: "dispensasjonPlanBestemmelse"
                    }
                }
            }
        ]
    }
};
