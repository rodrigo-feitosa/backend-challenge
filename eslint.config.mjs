import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Regra de reforço mecânico da restrição 5.1 do desafio:
 * dinheiro nunca passa por number/float/double — proibido converter
 * valores monetários via Number(), parseFloat() ou parseInt() no domínio.
 */
const moneyCoercionSelectors = [
  {
    selector: "CallExpression[callee.name='Number']",
    message: 'Restrição 5.1: use Money/Decimal (string decimal), nunca Number() para valores monetários.',
  },
  {
    selector: "CallExpression[callee.name='parseFloat']",
    message: 'Restrição 5.1: use Money/Decimal (string decimal), nunca parseFloat() para valores monetários.',
  },
  {
    selector: "CallExpression[callee.name='parseInt']",
    message: 'Restrição 5.1: use Money/Decimal (string decimal), nunca parseInt() para valores monetários.',
  },
];

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'migrations/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrors: 'all', caughtErrorsIgnorePattern: '^_' },
      ],
      // NOTA: consistent-type-imports é desativada de propósito — ela reescreve
      // imports de classes injetáveis (DI do Nest) para `import type` e quebra
      // o emitDecoratorMetadata em runtime.
    },
  },
  {
    files: ['src/**/domain/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...moneyCoercionSelectors],
      'no-console': 'error',
    },
  },
  {
    files: ['test/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
