export default {
    $schema: "https://altinncdn.no/toolkits/altinn-app-frontend/4/schemas/json/layout/layout.schema.v1.json",
    data: {
        layout: [
            {
                id: "custom-dispensasjonsvarsel",
                type: "Custom",
                tagName: "custom-dispensasjonsvarsel",
                dataModelBindings: {
                    annetTema: {
                        dataType: "DispensasjonsvarselDataV1",
                        field: "annetTema"
                    },
                    bestemmelsesoverskrift: {
                        dataType: "DispensasjonsvarselDataV1",
                        field: "bestemmelsesoverskrift"
                    },
                    bestemmelsestekst: {
                        dataType: "DispensasjonsvarselDataV1",
                        field: "bestemmelsestekst"
                    },
                    bestemmelsestype: {
                        dataType: "DispensasjonsvarselDataV1",
                        field: "bestemmelsestype"
                    },
                    dispVarselBeskrivelse: {
                        dataType: "DispensasjonsvarselDataV1",
                        field: "dispVarselBeskrivelse"
                    },
                    dispensasjonstema: {
                        dataType: "DispensasjonsvarselDataV1",
                        field: "dispensasjonstema"
                    },
                    paragrafnummer: {
                        dataType: "DispensasjonsvarselDataV1",
                        field: "paragrafnummer"
                    },
                    plannavn: {
                        dataType: "DispensasjonsvarselDataV1",
                        field: "plannavn"
                    }
                }
            }
        ]
    }
};
