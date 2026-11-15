import { useCallback, useRef, useState } from "react";
import { bytes } from "../components/ui";

interface CodeEditorProps {
  path: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  disabled?: boolean;
}

const INDENT = "  ";

export function CodeEditor({ path, value, onChange, onSave, disabled }: CodeEditorProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });

  const lines = value.split("\n");

  const syncScroll = useCallback(() => {
    if (gutterRef.current && taRef.current) {
      gutterRef.current.scrollTop = taRef.current.scrollTop;
    }
  }, []);

  const updateCursor = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    const upto = ta.value.slice(0, ta.selectionStart);
    const line = upto.split("\n");
    setCursor({ line: line.length, col: (line[line.length - 1]?.length ?? 0) + 1 });
  }, []);

  function replaceRange(next: string, selStart: number, selEnd: number) {
    onChange(next);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(selStart, selEnd);
      updateCursor();
    });
  }

  function handleTab(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const ta = taRef.current;
    if (!ta) return;
    e.preventDefault();
    const { selectionStart: s, selectionEnd: end, value: v } = ta;

    if (e.shiftKey) {
      // Outdent: strip up to INDENT.length leading spaces on each selected line.
      const lineStart = v.lastIndexOf("\n", s - 1) + 1;
      const blockEnd = (() => {
        const nl = v.indexOf("\n", end);
        return nl === -1 ? v.length : nl;
      })();
      const block = v.slice(lineStart, blockEnd);
      const stripped = block
        .split("\n")
        .map((l) => l.replace(/^ {1,2}/, ""))
        .join("\n");
      if (stripped !== block) {
        replaceRange(v.slice(0, lineStart) + stripped + v.slice(blockEnd), s, s + (stripped.length - (block.length - (end - s))));
      }
      return;
    }

    if (s !== end && v.slice(s, end).includes("\n")) {
      // Indent every selected line.
      const lineStart = v.lastIndexOf("\n", s - 1) + 1;
      const blockEnd = (() => {
        const nl = v.indexOf("\n", end);
        return nl === -1 ? v.length : nl;
      })();
      const block = v.slice(lineStart, blockEnd);
      const indented = block
        .split("\n")
        .map((l) => INDENT + l)
        .join("\n");
      replaceRange(v.slice(0, lineStart) + indented + v.slice(blockEnd), s, s + (indented.length - (block.length - (end - s))));
      return;
    }

    // Single cursor: insert one indent step.
    replaceRange(v.slice(0, s) + INDENT + v.slice(end), s + INDENT.length, s + INDENT.length);
  }

  return (
    <div className="editor-shell">
      <div className="editor-wrap">
        <div className="editor-gutter mono" ref={gutterRef} aria-hidden="true">
          {lines.map((_, i) => (
            <div key={i} className={i + 1 === cursor.line ? "active" : undefined}>
              {i + 1}
            </div>
          ))}
        </div>
        <textarea
          ref={taRef}
          className="editor mono"
          spellCheck={false}
          disabled={disabled}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            updateCursor();
          }}
          onScroll={syncScroll}
          onClick={updateCursor}
          onKeyUp={updateCursor}
          onKeyDown={(e) => {
            if (e.key === "Tab") {
              handleTab(e);
              return;
            }
            if ((e.metaKey || e.ctrlKey) && e.key === "s") {
              e.preventDefault();
              onSave();
            }
          }}
        />
      </div>
      <div className="editor-status mono">
        <span>
          Ln {cursor.line}, Col {cursor.col}
        </span>
        <span>
          {lines.length} lines · {bytes(new Blob([value]).size)}
        </span>
      </div>
      <span className="sr-only">{path}</span>
    </div>
  );
}
