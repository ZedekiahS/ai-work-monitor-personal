const path = require("node:path");
module.exports = {
  appId: "local.ai.quota.window",
  productName: "AI Quota Window",
  electronVersion: "45.1.0",
  directories: { output: path.resolve(__dirname, "../../release/quota-only") },
  artifactName: "AI.Quota.Window.Setup.${version}.${ext}",
  asar: true,
  files: [
    "main.cjs",
    "preload.cjs",
    "widget.cjs",
    "collector/quota-only.js",
    "collector/quota-wire.js",
    "ui/**/*",
    "icon.*",
    "package.json",
    "LICENSE",
    "licenses/*",
    "third_party/*",
  ],
  win: { icon: "icon.ico", target: "nsis" },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
  },
};
