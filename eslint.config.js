const js = require("@eslint/js");

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        window: "readonly",
        document: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        navigator: "readonly",
        crypto: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
        location: "readonly",
        alert: "readonly",
        confirm: "readonly",
        CustomEvent: "readonly",
        HTMLElement: "readonly",
        Event: "readonly",
        URL: "readonly",
        HTMLTextAreaElement: "readonly",
        HTMLInputElement: "readonly",
        FileReader: "readonly",
        Blob: "readonly",
        Request: "readonly",
        Headers: "readonly",
        Response: "readonly",
      }
    },
    rules: {
      "no-unused-vars": ["error", { "vars": "all", "args": "all", "caughtErrors": "none" }],
      "no-empty": "off"
    }
  }
];
