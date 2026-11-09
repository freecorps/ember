// The config plugin's entry for resolvers that look for `app.plugin.js` only, through Node's resolution (so it must
// be in `exports` too): eas-cli bundles such an @expo/config-plugins, and without this file it loads the package's
// main entry and refuses it ("does not contain a valid config plugin"). The package is ESM, so this file is too; the
// plugin itself stays plain CommonJS in app.plugin.cjs, which current Expo CLIs load directly.
import { createRequire } from "node:module";

export default createRequire(import.meta.url)("./app.plugin.cjs");
