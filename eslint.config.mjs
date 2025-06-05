import globals from 'globals'
import pluginJs from '@eslint/js'
import pluginReact from 'eslint-plugin-react'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: ['docs', 'coverage', 'dist', 'test/*.d.ts'],
  },
  {
    files: ['**/*.{js,mjs,cjs,jsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    settings: {
      react: {
        version: 'detect', // Automatically detects the React version
      },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    settings: {
      react: {
        version: 'detect', // Automatically detects the React version
      },
    },
  },
  pluginJs.configs.recommended,
  pluginReact.configs.flat.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    rules: {
      'react/prop-types': 'off',
    },
  },
]