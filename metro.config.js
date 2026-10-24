// Learn more: https://docs.expo.dev/guides/customizing-metro/
const path = require('path');
const fs = require('fs');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Windows MAX_PATH workaround: this machine keeps react-native-safe-area-context
// behind a junction at D:\n\sacontext so the CMake object paths stay under 260
// characters. Metro resolves the junction to its real path, which is outside the
// project root, so it has to be watched explicitly. Ignored on machines without
// the junction.
const shortModuleDir = 'D:\\n\\sacontext';
if (fs.existsSync(shortModuleDir)) {
  config.watchFolders = [...(config.watchFolders ?? []), shortModuleDir];
  // Files under the junction resolve imports from there, so keep the project's
  // node_modules on the resolver's search path.
  config.resolver.nodeModulesPaths = [
    path.resolve(__dirname, 'node_modules'),
    ...(config.resolver.nodeModulesPaths ?? []),
  ];
}

module.exports = config;
