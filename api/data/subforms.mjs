// Dependencies
import { subformApps } from "@arkitektum/ftpb-app-catalogue";

// Data
import DispensasjonssoeknadDataV1 from "./subforms/DispensasjonssoeknadDataV1.mjs";
import DispensasjonsvarselDataV1 from "./subforms/DispensasjonsvarselDataV1.mjs";
import GjennomfoeringsplanDataV7 from "./subforms/GjennomfoeringsplanDataV7.mjs";
import GjenpartNabovarselDataV3 from "./subforms/GjenpartNabovarselDataV3.mjs";

/**
 * The display layout this repository holds for each subform data type.
 *
 * This is the part of a subform that is genuinely local: the layout is written here and exists nowhere else. Which
 * subforms there are, who owns them and what they are called is the catalogue's business, not this file's.
 */
const layoutsByDataType = {
    DispensasjonssoeknadDataV1,
    DispensasjonsvarselDataV1,
    GjennomfoeringsplanDataV7,
    GjenpartNabovarselDataV3
};

/**
 * The subforms this API serves, each paired with the display layout held here for it.
 *
 * Identity comes from `@arkitektum/ftpb-app-catalogue`, the same list `altinnStudioApps.mjs` reads, because this
 * file used to repeat the owner, name and data type of every subform and nothing reconciled the two copies. They
 * happened to agree; they had no reason to stay that way. Add a subform to the catalogue, and a layout here.
 *
 * Projected into this repository's spelling on the way in, as `altinnStudioApps.mjs` does: the catalogue says `org`
 * and `app` where this repository has always said `appOwner` and `appName`.
 *
 * A catalogue subform with no layout here is left out rather than served without one, since every consumer reads
 * the layout. That is drift worth noticing, and `npm run drift` is where it belongs.
 *
 * @type {Array<{appOwner: string, appName: string, isSubform: true, dataType: string, layout: Object}>}
 */
const subforms = subformApps()
    .filter(({ dataType }) => layoutsByDataType[dataType])
    .map(({ org, app, dataType }) => ({
        appOwner: org,
        appName: app,
        isSubform: true,
        dataType,
        layout: layoutsByDataType[dataType]
    }));

export default subforms;
