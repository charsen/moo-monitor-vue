import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage', '*.config.ts', '*.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // TS 编译器已负责未定义检查;浏览器/Node 全局不必在 lint 层再声明。
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
)
