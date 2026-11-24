// The Monarch definitions ship as plain ESM without typings; setup.ts derives oIDE's TypeScript and
// JavaScript tokenizers from them (function names get their own token, as on the canvas).
declare module 'monaco-editor/languages/definitions/typescript/typescript' {
  import type { languages } from 'monaco-editor/editor';
  export const language: languages.IMonarchLanguage;
  export const conf: languages.LanguageConfiguration;
}
declare module 'monaco-editor/languages/definitions/javascript/javascript' {
  import type { languages } from 'monaco-editor/editor';
  export const language: languages.IMonarchLanguage;
  export const conf: languages.LanguageConfiguration;
}
