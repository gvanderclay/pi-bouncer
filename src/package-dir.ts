import { dirname } from "node:path";

/** The folder Pi loaded the bouncer from: the package root, one level above src/. */
export const PACKAGE_DIR: string = dirname(import.meta.dirname);
