import Constants from "expo-constants";
import { registerRootComponent } from "expo";
import { defineEmberPushTask } from "@freecorps/ember-expo-push";
import App from "./src/App";

// Direct push (EMBER_PUSH_DIRECT=1): Android decrypts sealed data-only pushes in a background task, which must be
// defined at module top level so headless JS finds it when the app is not running.
if (Constants.expoConfig?.extra?.pushTransport === "direct") defineEmberPushTask();

registerRootComponent(App);
