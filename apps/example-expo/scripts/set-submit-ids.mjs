// eas.json only expands $VARS in the ASC API key fields, not in ascAppId/appleTeamId. This fills those two from
// ASC_APP_ID and APPLE_TEAM_ID (CI or a local shell) before `eas submit` / `eas build --auto-submit`.
import { readFileSync, writeFileSync } from "node:fs";

const file = new URL("../eas.json", import.meta.url);
const { ASC_APP_ID, APPLE_TEAM_ID } = process.env;
if (!ASC_APP_ID || !/^\d+$/.test(ASC_APP_ID)) throw new Error("set ASC_APP_ID (digits, from App Store Connect → App Information → Apple ID)");
if (!APPLE_TEAM_ID) throw new Error("set APPLE_TEAM_ID (developer.apple.com → Membership)");
const eas = JSON.parse(readFileSync(file, "utf8"));
eas.submit.production.ios.ascAppId = ASC_APP_ID;
eas.submit.production.ios.appleTeamId = APPLE_TEAM_ID;
writeFileSync(file, JSON.stringify(eas, null, 2) + "\n");
console.log(`eas.json: submit.production.ios.ascAppId=${ASC_APP_ID} appleTeamId=${APPLE_TEAM_ID}`);
