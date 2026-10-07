// Dependencies
import { isIP } from "node:net";

/**
 * Whether a request's Host header names this server, rather than some other name that happens to resolve to it.
 *
 * Binding loopback keeps other machines out, but not a web page in your own browser: a page on a domain whose DNS the
 * page's owner controls can point that domain at 127.0.0.1 once loaded, and then reach the API same-origin, which CORS
 * does nothing about. That request still carries the page's own name in its Host header, so answering only to names
 * that are ours is what closes it. An IP address is always ours to accept, since no page can make a browser send one in
 * place of its own name.
 *
 * @param {string | undefined} hostHeader - The Host header as received, port included.
 * @param {readonly string[]} [allowedNames=[]] - Further host names to accept, lowercase.
 * @returns {boolean} True when the request may be answered.
 */
export function isAllowedHost(hostHeader, allowedNames = []) {
    if (!hostHeader) return false;
    const name = hostName(hostHeader.trim().toLowerCase());
    return name === "localhost" || name.endsWith(".localhost") || isIP(name) !== 0 || allowedNames.includes(name);
}

/**
 * The name part of a Host header: without its port, and an IPv6 address without its brackets.
 *
 * @param {string} host
 * @returns {string}
 */
function hostName(host) {
    if (host.startsWith("[")) {
        const end = host.indexOf("]");
        return end === -1 ? "" : host.slice(1, end);
    }
    const colon = host.indexOf(":");
    return colon === -1 ? host : host.slice(0, colon);
}

/**
 * The host names `ALLOWED_HOSTS` adds, comma-separated in the environment.
 *
 * @returns {string[]}
 */
export function allowedHostsSetting() {
    return (process.env.ALLOWED_HOSTS ?? "")
        .split(",")
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean);
}
