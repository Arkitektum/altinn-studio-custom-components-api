// Dependencies
import "dotenv/config";

// Local functions
import { createApp } from "./app.mjs";

const envPort = process.env.API_PORT;
const parsedPort = envPort === undefined ? Number.NaN : Number.parseInt(envPort, 10);
const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 3000;

if (port !== parsedPort) {
    const envPortMsg = envPort ? ' ("' + envPort + '")' : "";
    console.warn(`Invalid or missing API_PORT environment variable${envPortMsg}. Falling back to default port ${port}.`);
}

// Loopback by default: the API serves private Altinn Studio content fetched with your Gitea token to whoever can reach it.
const host = process.env.API_HOST || "127.0.0.1";

// Express hands a failure to bind (the port taken, the address not this machine's) to this callback rather than throwing.
createApp().listen(port, host, (error) => {
    if (error) {
        console.error(`Altinn Studio Custom Components API could not listen on ${host}:${port}: ${error.message}`);
        process.exit(1);
    }
    const reach = host === "127.0.0.1" || host === "localhost" ? "this machine only" : "reachable from the network";
    console.log(`Altinn Studio Custom Components API listening on port ${port} (${host}, ${reach})`);
});
