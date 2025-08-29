import js from '@eslint/js';
import typescriptEslint from 'typescript-eslint';
import prettierPlugin from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

export default typescriptEslint.config(
  js.configs.recommended,
  ...typescriptEslint.configs.recommended,
  {
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      ...prettierConfig.rules,
      'prettier/prettier': 'error',
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { 
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_'
      }],
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname || process.cwd(),
      },
    },
  },
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.eslintrc.js',
      'eslint.config.js',
      '*.spec.ts',
      'test/**',
      'coverage/**',
      '*.js',
      '*.mjs',
    ],
  },
);