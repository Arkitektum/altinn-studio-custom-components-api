export default {
    $schema: "https://altinncdn.no/toolkits/altinn-app-frontend/4/schemas/json/layout/layout.schema.v1.json",
    data: {
        layout: [
            {
                id: "custom-gjenpart-nabovarsel",
                type: "Custom",
                tagName: "custom-gjenpart-nabovarsel",
                dataModelBindings: {
                    ansvarligSoeker: {
                        dataType: "GjenpartNabovarselDataV3",
                        field: "ansvarligSoeker"
                    },
                    eiendomByggested: {
                        dataType: "GjenpartNabovarselDataV3",
                        field: "eiendomByggested"
                    },
                    kontaktpersonForNabovarselet: {
                        dataType: "GjenpartNabovarselDataV3",
                        field: "kontaktpersonForNabovarselet"
                    },
                    naboGjenboerEiendommer: {
                        dataType: "GjenpartNabovarselDataV3",
                        field: "naboGjenboerEiendommer"
                    },
                    planer: {
                        dataType: "GjenpartNabovarselDataV3",
                        field: "planer"
                    },
                    soeknadGjelder: {
                        dataType: "GjenpartNabovarselDataV3",
                        field: "soeknadGjelder"
                    },
                    tiltakshaver: {
                        dataType: "GjenpartNabovarselDataV3",
                        field: "tiltakshaver"
                    }
                }
            }
        ]
    }
};
