import js from "@eslint/js"
import react from "eslint-plugin-react"
import hooks from "eslint-plugin-react-hooks"

// Node 侧文件的全局（客户端全局在下面单独一份）
const nodeGlobals = {
  process: "readonly",
  structuredClone: "readonly",
  Buffer: "readonly",
  WebSocket: "readonly",
  HTMLCanvasElement: "readonly",
  console: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  fetch: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  Blob: "readonly",
  FormData: "readonly",
  performance: "readonly",
  Request: "readonly",
  Response: "readonly",
  Headers: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
}

export default [
  { ignores: ["client/dist/**", "client/public/**", "data/**", "node_modules/**", ".tower/**", ".agents/**", ".wrangler/**", "dist-e2e/**", "client/dist-e2e/**"] },
  js.configs.recommended,
  {
    files: ["**/*.{js,jsx,mjs}"],
    plugins: { react, "react-hooks": hooks },
    rules: {
      // 这轮重构的保护网：hooks 规则是硬错误；依赖数组告警先留着，不阻塞。
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // 没这条 no-unused-vars 认不出 JSX 里的组件引用。
      "react/jsx-uses-vars": "error",
      // Express 中间件的 (req, _res, _next) 这类占位参数是惯例。
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["client/**/*.{js,jsx}"],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    files: ["server/**/*.js", "scripts/**/*.mjs", "tests/**/*.mjs", "eslint.config.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: nodeGlobals },
  },
  {
    files: ["client/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...nodeGlobals,
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        EventSource: "readonly",
        requestIdleCallback: "readonly",
        cancelIdleCallback: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        ResizeObserver: "readonly",
        MutationObserver: "readonly",
        IntersectionObserver: "readonly",
        matchMedia: "readonly",
        getComputedStyle: "readonly",
        CustomEvent: "readonly",
        FileReader: "readonly",
        history: "readonly",
        location: "readonly",
        Element: "readonly",
        crypto: "readonly",
        HTMLElement: "readonly",
        alert: "readonly",
        confirm: "readonly",
      },
    },
  },
  {
    files: ["cloudflare/**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: {
      ...nodeGlobals, Request: "readonly", Response: "readonly", Headers: "readonly",
      TextEncoder: "readonly", TextDecoder: "readonly", WebSocketPair: "readonly", WebSocketRequestResponsePair: "readonly",
    } },
  },
  {
    files: ["shared/**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: nodeGlobals },
  },
]
