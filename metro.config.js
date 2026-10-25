// Metro 配置：react-native-safe-area-context 的实体可以放在盘外目录，
// node_modules 里用 junction 指过去（规避 Windows MAX_PATH 260 长度坑）。
// Metro 默认不 watch 工程根目录之外的文件，需要用 watchFolders 把它接进来；
// 没有 junction 的机器上保持默认配置即可。
const fs = require('fs');
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// junction 指到盘外的实际包目录
const shortModuleDir = 'D:/n/sacontext';
if (fs.existsSync(shortModuleDir)) {
  config.watchFolders = [...(config.watchFolders ?? []), shortModuleDir];
  // 从 junction 里解析的 import 也要能找到工程自己的 node_modules
  config.resolver.nodeModulesPaths = [
    path.resolve(__dirname, 'node_modules'),
    path.dirname(shortModuleDir),
    ...(config.resolver.nodeModulesPaths ?? []),
  ];
}

module.exports = config;
