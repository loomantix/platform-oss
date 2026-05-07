/** @format */

// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import jsdoc from 'eslint-plugin-jsdoc';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.d.ts',
      '**/coverage/**',
      '**/.pnpm-store/**',
      'scripts/leak_scan/**',
      'eslint.config.mjs',
    ],
  },

  eslint.configs.recommended,
  prettierConfig,
  eslintPluginPrettierRecommended,

  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        console: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
      },
    },
    rules: { 'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }] },
  },

  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['packages/*/src/**/*.ts', 'packages/*/*.config.ts'],
    rules: {
      ...config.rules,
      'no-unused-vars': 'off',
      'no-redeclare': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-undef': 'off',
    },
  })),

  // JSDoc documentation rules for SOC2 compliance.
  // Enforces documentation on exported code for audit requirements.
  {
    files: ['packages/*/src/**/*.ts'],
    ignores: [
      '**/*.spec.ts',
      '**/*.test.ts',
      '**/tests/**',
      '**/scripts/**',
      '**/*.d.ts',
      '**/index.ts',
      '**/main.ts',
    ],
    plugins: { jsdoc },
    settings: { jsdoc: { mode: 'typescript' } },
    rules: {
      'jsdoc/require-jsdoc': [
        'warn',
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            MethodDefinition: false,
            ClassDeclaration: true,
            ArrowFunctionExpression: false,
            FunctionExpression: false,
          },
          contexts: [
            'ExportNamedDeclaration > TSInterfaceDeclaration',
            'ExportNamedDeclaration > TSTypeAliasDeclaration',
            'ExportDefaultDeclaration > ClassDeclaration',
          ],
          checkConstructors: false,
          checkGetters: false,
          checkSetters: false,
        },
      ],
      'jsdoc/require-description': [
        'warn',
        {
          contexts: ['ClassDeclaration', 'FunctionDeclaration'],
          checkConstructors: false,
        },
      ],
      'jsdoc/no-types': 'warn',
      'jsdoc/check-syntax': 'warn',
      'jsdoc/check-tag-names': ['warn', { definedTags: ['format'] }],
      'jsdoc/check-alignment': 'warn',
    },
  },
];
