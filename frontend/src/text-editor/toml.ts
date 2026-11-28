import { languages } from 'monaco-editor/editor/editor.api'

let registered = false

export function registerTomlLanguage() {
  if (registered) return
  registered = true

  languages.register({
    id: 'toml',
    extensions: ['.toml'],
    aliases: ['TOML', 'toml'],
    mimetypes: ['application/toml', 'text/x-toml'],
  })

  languages.setLanguageConfiguration('toml', {
    comments: { lineComment: '#' },
    brackets: [
      ['{', '}'],
      ['[', ']'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  })

  languages.setMonarchTokensProvider('toml', {
    defaultToken: '',
    tokenPostfix: '.toml',
    escapes: /\\(?:[btnfr"\\]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
    tokenizer: {
      root: [
        { include: '@whitespace' },
        [/^\s*\[\[[^\]]*\]\]/, 'metatag'],
        [/^\s*\[[^\]]*\]/, 'metatag'],
        [/([A-Za-z0-9_.-]+)(\s*)(=)/, ['key', '', 'delimiter']],
        [/"""/, 'string', '@multilineBasicString'],
        [/'''/, 'string', '@multilineLiteralString'],
        [/"/, 'string', '@basicString'],
        [/'[^']*'/, 'string'],
        [/\b(?:true|false)\b/, 'keyword'],
        [/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?/, 'number.date'],
        [/\d{2}:\d{2}:\d{2}(?:\.\d+)?/, 'number.date'],
        [/0x[0-9a-fA-F_]+/, 'number.hex'],
        [/0o[0-7_]+/, 'number.octal'],
        [/0b[01_]+/, 'number.binary'],
        [/[+-]?(?:inf|nan)\b/, 'number.float'],
        [/[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?/, 'number'],
        [/[{}[\],.=]/, 'delimiter'],
      ],
      whitespace: [
        [/[ \t\r\n]+/, ''],
        [/#.*$/, 'comment'],
      ],
      basicString: [
        [/[^\\"]+/, 'string'],
        [/@escapes/, 'string.escape'],
        [/\\./, 'string.escape.invalid'],
        [/"/, 'string', '@pop'],
      ],
      multilineBasicString: [
        [/"""/, 'string', '@pop'],
        [/[^\\"]+/, 'string'],
        [/@escapes/, 'string.escape'],
        [/\\./, 'string.escape.invalid'],
        [/"/, 'string'],
      ],
      multilineLiteralString: [
        [/'''/, 'string', '@pop'],
        [/[^']+/, 'string'],
        [/'/, 'string'],
      ],
    },
  })
}
