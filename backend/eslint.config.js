const tseslint = require('@typescript-eslint/eslint-plugin');
const tsparser = require('@typescript-eslint/parser');

module.exports = [
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    plugins: { '@typescript-eslint': tseslint },
    languageOptions: { parser: tsparser, parserOptions: { project: './tsconfig.json' } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
];
