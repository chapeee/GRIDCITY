import { autocompletion, closeBrackets } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { MSSQL, MySQL, PostgreSQL, SQLite, sql, type SQLDialect } from '@codemirror/lang-sql';
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, placeholder as placeholderText } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useRef } from 'react';

export type EditorLanguage = 'postgres' | 'mysql' | 'mssql' | 'sqlite' | 'json' | 'text';

const DIALECTS: Record<string, SQLDialect> = {
  postgres: PostgreSQL,
  mysql: MySQL,
  mssql: MSSQL,
  sqlite: SQLite,
};

/** Colors come from the design tokens (CSS variables), like the rest of the 2D layer. */
const theme = EditorView.theme(
  {
    '&': {
      color: 'var(--color-text)',
      backgroundColor: 'var(--color-base)',
      border: 'var(--panel-border)',
      fontSize: '12px',
    },
    '&.cm-focused': { outline: 'none', borderColor: 'var(--color-online)' },
    '.cm-content': {
      fontFamily: 'var(--font-mono)',
      caretColor: 'var(--color-online)',
      padding: '6px 0',
    },
    '.cm-scroller': { fontFamily: 'var(--font-mono)' },
    '.cm-gutters': {
      backgroundColor: 'var(--color-base)',
      color: 'var(--color-muted)',
      border: 'none',
    },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
      backgroundColor: 'color-mix(in srgb, var(--color-online) 25%, transparent) !important',
    },
    '.cm-cursor': { borderLeftColor: 'var(--color-online)' },
    '.cm-tooltip': {
      backgroundColor: 'var(--color-surface)',
      border: 'var(--panel-border)',
      color: 'var(--color-text)',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: 'color-mix(in srgb, var(--color-online) 25%, transparent)',
      color: 'var(--color-text-bright)',
    },
    '.cm-placeholder': { color: 'var(--color-muted)' },
    '.cm-matchingBracket': { color: 'var(--color-online)', outline: '1px solid var(--color-line)' },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.bool, tags.null], color: 'var(--color-online)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--color-degraded)' },
  { tag: [tags.number], color: 'var(--color-text-bright)' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: 'var(--color-muted)',
    fontStyle: 'italic',
  },
  { tag: [tags.propertyName, tags.typeName], color: 'var(--color-text-bright)' },
]);

function languageExtension(language: EditorLanguage, schema?: Record<string, string[]>): Extension {
  if (language === 'json') return json();
  if (language === 'text') return [];
  return sql({ dialect: DIALECTS[language], schema, upperCaseKeywords: true });
}

interface CodeEditorProps {
  value: string;
  onChange(value: string): void;
  language: EditorLanguage;
  /** table -> columns, for SQL completion. */
  schema?: Record<string, string[]>;
  /** Ctrl/Cmd+Enter. */
  onRun?(): void;
  placeholder?: string;
  minHeight?: number;
  maxHeight?: number;
  readOnly?: boolean;
  ariaLabel?: string;
}

/** A small CodeMirror 6 editor (SQL with schema completion, JSON, or text). */
export function CodeEditor({
  value,
  onChange,
  language,
  schema,
  onRun,
  placeholder,
  minHeight = 80,
  maxHeight = 360,
  readOnly = false,
  ariaLabel,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const languageSlot = useRef(new Compartment());
  const callbacks = useRef({ onChange, onRun });
  // The editor calls the latest handlers without being rebuilt.
  useEffect(() => {
    callbacks.current = { onChange, onRun };
  });

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                callbacks.current.onRun?.();
                return true;
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          languageSlot.current.of(languageExtension(language, schema)),
          syntaxHighlighting(highlight),
          theme,
          EditorView.lineWrapping,
          EditorState.readOnly.of(readOnly),
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel ?? 'Code editor' }),
          EditorView.theme({
            '&': { minHeight: `${minHeight}px`, maxHeight: `${maxHeight}px` },
            '.cm-scroller': { overflow: 'auto' },
          }),
          ...(placeholder ? [placeholderText(placeholder)] : []),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // The editor is created once; value/language changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Outside changes (a loaded document, a history entry) replace the text.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current !== value)
      editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: languageSlot.current.reconfigure(languageExtension(language, schema)),
    });
  }, [language, schema]);

  return <div className="code-editor" ref={host} />;
}
