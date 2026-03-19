export default {
    $schema: "https://altinncdn.no/toolkits/altinn-app-frontend/4/schemas/json/layout/layout.schema.v1.json",
    data: {
        layout: [
            {
                id: "custom-gjennomfoeringsplan",
                type: "Custom",
                tagName: "custom-gjennomfoeringsplan",
                dataModelBindings: {
                    versjon: {
                        dataType: "GjennomfoeringsplanDataV7",
                        field: "versjon"
                    },
                    gjennomfoeringsplan: {
                        dataType: "GjennomfoeringsplanDataV7",
                        field: "gjennomfoeringsplan"
                    },
                    metadata: {
                        dataType: "GjennomfoeringsplanDataV7",
                        field: "metadata"
                    },
                    kommunensSaksnummer: {
                        dataType: "GjennomfoeringsplanDataV7",
                        field: "kommunensSaksnummer"
                    },
                    eiendomByggested: {
                        dataType: "GjennomfoeringsplanDataV7",
                        field: "eiendomByggested"
                    },
                    ansvarligSoeker: {
                        dataType: "GjennomfoeringsplanDataV7",
                        field: "ansvarligSoeker"
                    }
                }
            }
        ]
    }
};
