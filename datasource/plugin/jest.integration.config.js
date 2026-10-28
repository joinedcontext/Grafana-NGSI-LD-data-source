// Integration tests against a running broker: npm run test:integration (see tests/integration)
const base = require('./jest.config');

module.exports = {
  ...base,
  testEnvironment: 'node',
  setupFilesAfterEnv: [],
  testMatch: ['<rootDir>/tests/integration/**/*.integration.ts'],
};
