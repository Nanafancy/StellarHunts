/**
 * Jest config for the stellar-extensions test suites.
 *
 * Run from the repository root:
 *   npx jest --config stellar-extensions/tests/jest.config.js
 */
module.exports = {
  rootDir: __dirname,
  testEnvironment: "node",
  testMatch: ["<rootDir>/**/*.test.ts"],
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/tsconfig.json",
        isolatedModules: true,
      },
    ],
  },
};
