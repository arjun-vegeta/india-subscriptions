const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

// The library is the parent directory. Metro watches it, and resolves `react` and `react-native` from this app only, so
// that the library's own copies (its development dependencies) are not bundled twice.
const library = path.resolve(__dirname, '..');

/** @type {import('@react-native/metro-config').MetroConfig} */
const config = {
  watchFolders: [library],
  resolver: {
    unstable_enablePackageExports: true,
    unstable_conditionNames: ['india-subscriptions-react-native-source'],
    blockList: [
      new RegExp(`${library}/node_modules/(react|react-native)/.*`),
    ],
    extraNodeModules: {
      react: path.resolve(__dirname, 'node_modules/react'),
      'react-native': path.resolve(__dirname, 'node_modules/react-native'),
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
