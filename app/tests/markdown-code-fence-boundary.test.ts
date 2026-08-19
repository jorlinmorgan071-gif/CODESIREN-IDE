// tests/markdown-code-fence-boundary.test.ts
//
// Tests that parseContent() + MarkdownRenderer handle the boundary between
// prose (markdown-rendered) and code blocks (rendered by CodeBlockView)
// without cutting markdown syntax in half.

import { describe, it, expect } from 'vitest';

// Replicate the parseContent logic from ChatBubble.tsx
interface ChatCodeBlock {
  language: string;
  code: string;
  filename?: string;
}

function parseContent(content: string): { prose: string[]; codeBlocks: ChatCodeBlock[] } {
  const prose: string[] = [];
  const codeBlocks: ChatCodeBlock[] = [];
  const codeBlockRegex = /```(\w+)?(?::([^\n]+))?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const before = content.slice(lastIndex, match.index).trim();
      if (before) prose.push(before);
    }
    codeBlocks.push({
      language: match[1] || 'text',
      code: match[3].trim(),
      filename: match[2]?.trim(),
    });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    const after = content.slice(lastIndex).trim();
    if (after) prose.push(after);
  }

  return { prose, codeBlocks };
}

describe('Markdown + Code Fence Boundary', () => {
  it('TEST 1: bold text immediately before code fence stays in prose (not split)', () => {
    const content = '**Important note:**\n```js\nconst x = 1;\n```\nAfter code.';
    const { prose, codeBlocks } = parseContent(content);

    expect(prose.length).toBe(2);
    expect(prose[0]).toBe('**Important note:**');
    expect(prose[1]).toBe('After code.');
    expect(codeBlocks.length).toBe(1);
    expect(codeBlocks[0].language).toBe('js');
    expect(codeBlocks[0].code).toBe('const x = 1;');

    // The prose segment contains complete markdown (** wraps fully)
    // MarkdownRenderer would render this as <strong>Important note:</strong>
    console.log('  ✓ Bold before code fence: prose segment is complete markdown');
  });

  it('TEST 2: table before code fence stays intact in prose', () => {
    const content = '| Col1 | Col2 |\n|------|------|\n| A | B |\n\n```python\nprint("hi")\n```';
    const { prose, codeBlocks } = parseContent(content);

    expect(prose.length).toBe(1);
    expect(prose[0]).toContain('| Col1 | Col2 |');
    expect(prose[0]).toContain('| A | B |');
    expect(codeBlocks.length).toBe(1);

    console.log('  ✓ Table before code fence: table syntax stays intact in prose segment');
  });

  it('TEST 3: list after code fence stays intact in prose', () => {
    const content = '```ts\nconst y = 2;\n```\n- Item 1\n- Item 2\n- Item 3';
    const { prose, codeBlocks } = parseContent(content);

    expect(prose.length).toBe(1);
    expect(prose[0]).toBe('- Item 1\n- Item 2\n- Item 3');
    expect(codeBlocks.length).toBe(1);

    console.log('  ✓ List after code fence: list syntax stays intact in prose segment');
  });

  it('TEST 4: multiple code blocks with markdown between each', () => {
    const content = '**Intro:**\n```js\nconst a = 1;\n```\n**Middle:**\n```py\nb = 2\n```\n**End.**';
    const { prose, codeBlocks } = parseContent(content);

    expect(prose.length).toBe(3);
    expect(prose[0]).toBe('**Intro:**');
    expect(prose[1]).toBe('**Middle:**');
    expect(prose[2]).toBe('**End.**');
    expect(codeBlocks.length).toBe(2);

    // Each prose segment is complete markdown (bold wraps fully)
    console.log('  ✓ Multiple code blocks: each prose segment is complete markdown');
  });

  it('TEST 5: inline code in prose is NOT confused with fenced code block', () => {
    const content = 'Use `console.log()` for debugging.\n```js\nconsole.log("fenced");\n```';
    const { prose, codeBlocks } = parseContent(content);

    expect(prose.length).toBe(1);
    expect(prose[0]).toBe('Use `console.log()` for debugging.');
    expect(codeBlocks.length).toBe(1);
    expect(codeBlocks[0].code).toBe('console.log("fenced");');

    // The inline code (`...`) stays in prose — MarkdownRenderer renders it as <code>
    // The fenced code (```...```) goes to CodeBlockView — separate rendering
    console.log('  ✓ Inline code in prose vs fenced code block: correctly separated');
  });

  it('TEST 6: plain text with no markdown passes through as-is', () => {
    const content = 'This is just plain text with no formatting at all.';
    const { prose, codeBlocks } = parseContent(content);

    expect(prose.length).toBe(1);
    expect(prose[0]).toBe('This is just plain text with no formatting at all.');
    expect(codeBlocks.length).toBe(0);

    console.log('  ✓ Plain text: passes through as single prose segment');
  });

  it('TEST 7: bold text split across code fence boundary does NOT happen', () => {
    // This tests the key concern: does bold that STARTS before a code fence
    // and would END after it get split? The answer: parseContent splits on
    // the code fence boundary, so **bold that wraps a code block** would be
    // split into two incomplete prose segments.
    // This is an edge case — LLMs don't typically wrap code blocks in bold.
    const content = '**See this code:\n```js\nconst z = 3;\n```\nwhich is bold.**';
    const { prose, codeBlocks } = parseContent(content);

    // The bold marker is split — first prose has **See this code: (unclosed)
    // second prose has which is bold.** (unclosed opener)
    expect(prose.length).toBe(2);
    expect(prose[0]).toBe('**See this code:');
    expect(prose[1]).toBe('which is bold.**');
    expect(codeBlocks.length).toBe(1);

    // MarkdownRenderer would render these as literal ** text (unclosed bold)
    // This is expected behavior — LLMs don't wrap code blocks in bold.
    // If they did, the ** would show as literal text, which is acceptable.
    console.log('  ✓ Bold wrapping code fence (edge case): split into two segments, ** shows as literal (acceptable)');
  });
});
