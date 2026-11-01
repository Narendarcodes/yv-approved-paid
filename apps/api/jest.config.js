module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  setupFiles: ['<rootDir>/tests/setup.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/teardown.js'],
  // .cts = TypeScript in CommonJS (runs natively on Node's type stripping).
  moduleFileExtensions: ['js', 'cjs', 'cts', 'ts', 'json', 'node'],
  transform: {
    '\\.c?ts$': '<rootDir>/jest.transform-ts.cjs',
    '\\.[cm]?jsx?$': 'babel-jest',
  },
  collectCoverageFrom: ['src/**/*.{js,cts}'],
  coverageDirectory: 'coverage',
  verbose: true,
};
