const { build } = require("../package.json");
module.exports = {
  ...build,
  appId: "local.ai.work.monitor.widget",
  productName: "AI Usage Window",
  directories: { output: "release/widget" },
  artifactName: "AI.Usage.Window.Setup.${version}.${ext}",
  extraMetadata: {
    ...build.extraMetadata,
    main: "desktop/widget-main.cjs",
    description: "Local AI quota and usage window",
  },
  nsis: { ...build.nsis, deleteAppDataOnUninstall: false },
};
