// app/src/components/chat/elements/MarkdownRenderer.tsx
//
// Renders markdown prose segments with Code Siren theme tokens.
// Used by ChatBubble for assistant messages after streaming completes.
// During streaming, TypewriterText shows raw text (no formatting) —
// when streaming ends, this component renders the final formatted version.
//
// Fenced code blocks (```...```) are handled separately by parseContent()
// and CodeBlockView — this component only handles the prose segments between
// code blocks. Inline code (`code`) IS handled here (different from fenced).

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

const themeComponents: Components = {
  p: ({ children }) => (
    <p style={{ color: 'var(--bright-silver)', margin: '0 0 0.5em 0', lineHeight: 1.5 }}>
      {children}
    </p>
  ),
  strong: ({ children }) => (
    <strong style={{ color: 'var(--bright-silver)', fontWeight: 600 }}>
      {children}
    </strong>
  ),
  em: ({ children }) => (
    <em style={{ color: 'var(--bright-silver)' }}>{children}</em>
  ),
  code: ({ children }) => (
    <code
      style={{
        backgroundColor: 'var(--surface-raised)',
        color: 'var(--siren-red)',
        padding: '1px 4px',
        borderRadius: '3px',
        fontSize: '0.9em',
        fontFamily: 'JetBrains Mono, monospace',
      }}
    >
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre style={{ margin: '0.5em 0', overflow: 'auto' }}>{children}</pre>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{ color: 'var(--siren-red)', textDecoration: 'none' }}
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul style={{ color: 'var(--bright-silver)', paddingLeft: '1.2em', margin: '0.3em 0' }}>
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol style={{ color: 'var(--bright-silver)', paddingLeft: '1.5em', margin: '0.3em 0' }}>
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li style={{ marginBottom: '0.15em' }}>{children}</li>
  ),
  table: ({ children }) => (
    <table
      style={{
        borderCollapse: 'collapse',
        width: '100%',
        margin: '0.5em 0',
        fontSize: '0.9em',
      }}
    >
      {children}
    </table>
  ),
  thead: ({ children }) => (
    <thead style={{ backgroundColor: 'var(--surface-raised)' }}>{children}</thead>
  ),
  th: ({ children }) => (
    <th
      style={{
        border: '1px solid var(--border-subtle)',
        padding: '4px 8px',
        color: 'var(--bright-silver)',
        textAlign: 'left',
        fontWeight: 600,
      }}
    >
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td
      style={{
        border: '1px solid var(--border-subtle)',
        padding: '4px 8px',
        color: 'var(--steel-silver)',
      }}
    >
      {children}
    </td>
  ),
  blockquote: ({ children }) => (
    <blockquote
      style={{
        borderLeft: '3px solid var(--siren-red)',
        paddingLeft: '0.75em',
        margin: '0.5em 0',
        color: 'var(--muted-silver)',
      }}
    >
      {children}
    </blockquote>
  ),
  h1: ({ children }) => (
    <h1 style={{ color: 'var(--bright-silver)', fontSize: '1.3em', fontWeight: 600, margin: '0.5em 0 0.3em' }}>
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 style={{ color: 'var(--bright-silver)', fontSize: '1.15em', fontWeight: 600, margin: '0.5em 0 0.3em' }}>
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 style={{ color: 'var(--bright-silver)', fontSize: '1.05em', fontWeight: 600, margin: '0.4em 0 0.2em' }}>
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 style={{ color: 'var(--bright-silver)', fontSize: '1em', fontWeight: 600, margin: '0.4em 0 0.2em' }}>
      {children}
    </h4>
  ),
  hr: () => (
    <hr style={{ border: 'none', borderTop: '1px solid var(--border-subtle)', margin: '0.75em 0' }} />
  ),
};

export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="text-[13px] leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={themeComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
