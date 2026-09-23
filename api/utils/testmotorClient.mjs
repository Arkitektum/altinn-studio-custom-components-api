// Dependencies
import { createTestmotorClient } from "@arkitektum/ftpb-testmotor-client";

/**
 * The FtPB testmotor, which is where the main form example data comes from.
 *
 * The client itself lives in `@arkitektum/ftpb-testmotor-client`, shared with altinn-studio-api-tools, which reads the same two endpoints and used to carry its own copy of this. See that package for what it does and refuses to do: which entries it drops, why the files are not sorted, and how long an answer is reused.
 *
 * What is left here is the part that is this repository's own: where the testmotor lives, and the three functions the rest of the code already calls.
 */

/** Where the testmotor lives when nothing says otherwise. Overridable so a test, or a local instance, can be pointed at instead. */
const DEFAULT_TESTMOTOR_URL = "https://app-ftpb-testmotor.azurewebsites.net";

// The base url is given as a function, so it is read on every request rather than once at import. That is what lets `dotenv` run first, and what lets a test move the host between cases.
const client = createTestmotorClient({ baseUrl: () => process.env.TESTMOTOR_URL?.trim() || DEFAULT_TESTMOTOR_URL });

/** Forgets everything read so far. Only the tests need this. */
export function clearTestmotorCache() {
    client.clearCache();
}

/**
 * The apps the testmotor holds example data for, each with the data type its main form is filed under.
 *
 * Note that `mainFormId` is not unique: `fa-v3` and `fa-v5` are both filed under `FA` and hold different data. The app id is the key that identifies example data; the data type alone does not.
 *
 * @returns {Promise<Array<{appId: string, mainFormId: string}>>} The apps, in the order the testmotor answers them.
 * @throws {Error} If the testmotor could not be reached or did not answer a list.
 */
export function fetchTestmotorApps() {
    return client.fetchApps();
}

/**
 * One app's example form files, in the order the testmotor answers them.
 *
 * @param {string} appId - The app to fetch example files for, e.g. "fa-v5".
 * @returns {Promise<Array<{name: string, contents: string}>>} The example files. Empty when the testmotor holds none for this app.
 * @throws {Error} If the testmotor could not be reached or did not answer a list.
 */
export function fetchTestmotorFormXml(appId) {
    return client.fetchFormXml(appId);
}
