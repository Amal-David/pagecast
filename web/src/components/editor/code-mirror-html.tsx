import CodeMirror from "@uiw/react-codemirror";
import { html } from "@codemirror/lang-html";

// Lazily imported chunk: pulls @uiw/react-codemirror + @codemirror/lang-html out
// of the main bundle so the editor only loads when a report is opened.
export interface CodeMirrorHtmlProps {
  value: string;
  onChange: (value: string) => void;
}

export default function CodeMirrorHtml({
  value,
  onChange
}: CodeMirrorHtmlProps) {
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      height="100%"
      extensions={[html()]}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: true,
        foldGutter: true,
        autocompletion: true
      }}
      className="h-full text-sm [&_.cm-editor]:h-full [&_.cm-scroller]:font-mono"
    />
  );
}
