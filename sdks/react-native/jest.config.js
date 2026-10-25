module.exports = {
  preset: '@react-native/jest-preset',
  roots: ['<rootDir>/__tests__'],
  // `.jest.ts` keeps these files out of the globs that other test runners in the surrounding repository use.
  testMatch: ['**/*.jest.ts'],
};
