// Data
import DispensasjonssoeknadDataV1 from "./subforms/DispensasjonssoeknadDataV1.mjs";
import GjennomfoeringsplanDataV7 from "./subforms/GjennomfoeringsplanDataV7.mjs";
import GjenpartNabovarselDataV3 from "./subforms/GjenpartNabovarselDataV3.mjs";

export default [
    {
        appOwner: "dibk",
        appName: "dispensasjonssoeknad-v1",
        isSubform: true,
        dataType: "DispensasjonssoeknadDataV1",
        layout: DispensasjonssoeknadDataV1
    },
    {
        appOwner: "dibk",
        appName: "gjenpart-nabovarsel-v3",
        isSubform: true,
        dataType: "GjenpartNabovarselDataV3",
        layout: GjenpartNabovarselDataV3
    },
    {
        appOwner: "dibk",
        appName: "gjennomfoeringsplan-v7",
        isSubform: true,
        dataType: "GjennomfoeringsplanDataV7",
        layout: GjennomfoeringsplanDataV7
    }
];
