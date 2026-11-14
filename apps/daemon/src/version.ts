import root from "../../../package.json" with { type: "json" };

/**
 * Warren's version: the root package.json's, the one place it is set. Compiled into the binary,
 * so a release knows what it is without the source next to it.
 */
export const VERSION: string = root.version;
