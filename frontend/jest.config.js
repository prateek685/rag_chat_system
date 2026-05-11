const nextJest = require('next/jest.js');

const createJestConfig = nextJest({ dir: './' });

/** @type {import('jest').Config} */
const config = {
  testEnvironment: 'jest-environment-jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // uuid v14 is pure ESM — redirect to a CJS shim for the test environment
    '^uuid$': '<rootDir>/src/__mocks__/uuid.js',
    // react-markdown and its entire unified/rehype/remark ESM ecosystem is stubbed
    // for Jest — the XSS security contract is verified via sanitize-schema.spec.ts
    // which tests the schema directly without a browser render pipeline.
    '^react-markdown$': '<rootDir>/src/__mocks__/react-markdown.js',
    '^remark-gfm$': '<rootDir>/src/__mocks__/remark-gfm.js',
    '^remark-math$': '<rootDir>/src/__mocks__/remark-math.js',
    '^rehype-katex$': '<rootDir>/src/__mocks__/rehype-katex.js',
    '^rehype-sanitize$': '<rootDir>/src/__mocks__/rehype-sanitize.js',
    '^rehype-raw$': '<rootDir>/src/__mocks__/rehype-raw.js',
  },
  modulePathIgnorePatterns: ['<rootDir>/.next/'],
  testMatch: ['**/__tests__/**/*.spec.ts', '**/__tests__/**/*.spec.tsx'],
};

module.exports = createJestConfig(config);
