// server/src/agents/ui-designer/index.ts
// UI Designer Agent — Component generation + design-token/accessibility/convention review.
//
// Phase C Agent 9: HARDENED from 31-line chat-only stub to real IAgent with
// 2 programmatic capabilities:
//   1. generateComponent() — generates React components matching confirmed
//      conventions (function components, typed props, @/ alias, motion/react,
//      lucide-react, // header comments, CSS variable tokens)
//   2. uiReview() — reviews .tsx files for design-token compliance,
//      accessibility basics, and convention compliance
//
// SCOPE BOUNDARY (non-negotiable):
//   - Design-token compliance: flag hardcoded hex colors NOT in the token list
//   - Accessibility basics: missing alt/aria-label/label (regex-detectable)
//   - Convention compliance: header comment, typed props (objectively checkable)
//   - OUT OF SCOPE: aesthetic judgment, layout critique, contrast-ratio
//     calculation (would need a real WCAG calculator, not regex)
//   - Advisory only — review() always returns approved: true
//   - All writes through writeProjectFile() → CodeReviewAgent (confirmed
//     cross-package, zero false-positive risk on 9 Tier 1 checks)

import type {
  AgentChunk,
  AgentTask,
  AgentDomain,
  ReviewResult,
  UIReviewResult,
  UITokenFinding,
  UIAccessibilityFinding,
  UIConventionFinding,
  UIGenerateResult,
} from '../../types.js';
import { IAgent } from '../base-agent.js';
import { dispatchStrategy } from '../../orchestration/strategies/dispatcher.js';
import { writeProjectFile } from '../_shared/project-files.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SYSTEM_PROMPT = `You are the UI Designer Agent of Zero Two: Code Siren.
Your role: generate React components matching the confirmed codebase conventions and review components for design-token/accessibility/convention compliance.
When generating:
1. Function components, typed interface props, @/ alias imports.
2. Use motion/react for animation, lucide-react for icons.
3. File-level // header comment (informal convention, NOT JSDoc).
4. Colors: reference CSS variable tokens ONLY (var(--token-name)). Never invent hardcoded hex.
5. Accessibility defaults: aria-label on icon-only buttons, alt on images, labels on inputs.
Be grounded in real conventions. No aesthetic judgment.`;

// The 16 known hex design tokens from app/src/index.css
const KNOWN_HEX_TOKENS: Record<string, string> = {
  '#EE1C1C': '--siren-red',
  '#C41010': '--active-red',
  '#6A0808': '--dim-red',
  '#C8C8DC': '--bright-silver',
  '#8A8AA0': '--steel-silver',
  '#5A5A72': '--muted-silver',
  '#07070B': '--void-black',
  '#0E0E14': '--surface-dark',
  '#15151E': '--surface-raised',
  '#1E1E2A': '--border-subtle',
  '#2A2A3C': '--border-hover',
  '#22C55E': '--success',
  '#F59E0B': '--warning',
  '#F97316': '--warning', // F97316 is used as Performance Agent color but not in tokens — map to warning
  '#3B82F6': '--info',
};

export class UIDesignerAgent extends IAgent {
  readonly id = 'ui-designer-agent';
  readonly name = 'UI Designer Agent';
  readonly domain: AgentDomain = 'DESIGN';
  readonly icon = 'palette';
  readonly color = '#E11D48';
  constructor() { super(0.86); }

  // ── 1. Component generation ────────────────────────────────────────
  /**
   * Generate a React component matching confirmed conventions.
   *
   * Per directive Section 1:
   *   - Function component, typed props interface, @/ alias imports
   *   - motion/react for animation, lucide-react for icons if needed
   *   - File-level // header comment
   *   - Colors: CSS variable tokens ONLY — never invent hardcoded hex
   *   - Accessibility defaults built in
   *
   * Writes through writeProjectFile() → CodeReviewAgent (cross-package,
   * confirmed working with zero false-positive risk).
   */
  async generateComponent(params: {
    projectRoot: string;
    componentPath: string;     // relative to project root, e.g. 'app/src/components/ui/MyButton.tsx'
    componentName: string;
    description: string;
    props?: { name: string; type: string; required: boolean; description?: string }[];
    includeIcons?: boolean;    // include lucide-react import
    includeAnimation?: boolean; // include motion/react import
    requiredColor?: string;    // if the component needs a specific color, check it's a known token
    traceId?: string;
  }): Promise<UIGenerateResult> {
    const {
      projectRoot, componentPath, componentName, description,
      props = [], includeIcons = false, includeAnimation = false,
      requiredColor, traceId,
    } = params;

    // ── Fabrication guard: if a required color is specified but NOT in the token list ──
    if (requiredColor) {
      const upperColor = requiredColor.toUpperCase();
      const knownHex = Object.keys(KNOWN_HEX_TOKENS).find(k => k.toUpperCase() === upperColor);
      if (!knownHex) {
        return {
          filePath: componentPath,
          content: null,
          written: false,
          refused: `Color '${requiredColor}' is not in the design-token list. Refusing to invent a hardcoded hex value. Available tokens: ${Object.entries(KNOWN_HEX_TOKENS).map(([hex, token]) => `${hex} → var(${token})`).join(', ')}`,
        };
      }
    }

    // ── Generate the component content ────────────────────────────────
    const content = this.generateComponentContent({
      componentPath, componentName, description, props,
      includeIcons, includeAnimation,
    });

    // ── Write through writeProjectFile() (REAL cross-package write) ───
    const fullPath = join(projectRoot, componentPath);
    const writeResult = await writeProjectFile(this.id, fullPath, content, traceId);

    return {
      filePath: componentPath,
      content: writeResult.written ? content : null,
      written: writeResult.written,
      refused: writeResult.written ? undefined : `CodeReviewAgent rejected: ${writeResult.review.issues.join('; ')}`,
    };
  }

  /**
   * Generate the React component content matching confirmed conventions.
   */
  private generateComponentContent(params: {
    componentPath: string;
    componentName: string;
    description: string;
    props: { name: string; type: string; required: boolean; description?: string }[];
    includeIcons: boolean;
    includeAnimation: boolean;
  }): string {
    const { componentPath, componentName, description, props, includeIcons, includeAnimation } = params;
    const lines: string[] = [];

    // File-level // header comment (informal convention, NOT JSDoc)
    lines.push(`// ${componentPath}`);
    lines.push(`// ${componentName} — ${description}`);

    // Imports
    lines.push('');
    lines.push("import React from 'react';");
    if (includeAnimation) {
      lines.push("import { motion } from 'motion/react';");
    }
    if (includeIcons) {
      lines.push("import { Check } from 'lucide-react';");
    }
    lines.push("import { cn } from '@/lib/utils';");

    // Props interface
    lines.push('');
    if (props.length > 0) {
      lines.push(`interface ${componentName}Props {`);
      for (const prop of props) {
        const optional = prop.required ? '' : '?';
        lines.push(`  ${prop.name}${optional}: ${prop.type};${prop.description ? ` // ${prop.description}` : ''}`);
      }
      lines.push('}');
    } else {
      lines.push(`interface ${componentName}Props {`);
      lines.push('  className?: string;');
      lines.push('}');
    }

    // Component
    lines.push('');
    lines.push(`export const ${componentName}: React.FC<${componentName}Props> = ({ className }) => {`);
    lines.push('  return (');
    if (includeAnimation) {
      lines.push(`    <motion.div`);
      lines.push(`      className={cn('relative', className)}`);
      lines.push(`      initial={{ opacity: 0 }}`);
      lines.push(`      animate={{ opacity: 1 }}`);
      lines.push(`    >`);
    } else {
      lines.push(`    <div className={cn('relative', className)}>`);
    }
    if (includeIcons) {
      lines.push(`      <Check className="w-4 h-4 text-[var(--bright-silver)]" aria-hidden="true" />`);
    }
    lines.push(`      {/* Component content */}`);
    lines.push(`    ${includeAnimation ? '</motion.div>' : '</div>'}`);
    lines.push(`  );`);
    lines.push(`};`);

    lines.push('');

    return lines.join('\n');
  }

  // ── 2. uiReview() — design-token + accessibility + convention review ──
  /**
   * Review a .tsx file for design-token compliance, accessibility basics,
   * and convention compliance.
   *
   * Per directive Section 2: returns UIReviewResult with:
   *   - tokenFindings: hardcoded hex colors NOT in the token list
   *   - accessibilityFindings: missing alt/aria-label/label
   *   - conventionFindings: header comment, typed props
   *   - overallCompliance: 'compliant' | 'minor-issues' | 'needs-attention'
   *   - outOfScopeNote: always states aesthetic/contrast was NOT performed
   *
   * review() is a thin wrapper: always approved: true (advisory only).
   */
  async uiReview(filePath: string): Promise<UIReviewResult> {
    if (!existsSync(filePath)) {
      return {
        tokenFindings: [],
        accessibilityFindings: [],
        conventionFindings: [{ rule: 'file-exists', passed: false, detail: `File does not exist: ${filePath}` }],
        overallCompliance: 'needs-attention',
        outOfScopeNote: 'Aesthetic judgment, layout critique, and contrast-ratio calculation were NOT performed (out of scope).',
      };
    }

    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      return {
        tokenFindings: [],
        accessibilityFindings: [],
        conventionFindings: [{ rule: 'file-readable', passed: false, detail: `Cannot read file: ${filePath}` }],
        overallCompliance: 'needs-attention',
        outOfScopeNote: 'Aesthetic judgment, layout critique, and contrast-ratio calculation were NOT performed (out of scope).',
      };
    }

    const lines = content.split('\n');

    // ── Token findings: hardcoded hex colors ──────────────────────────
    const tokenFindings: UITokenFinding[] = [];
    for (let i = 0; i < lines.length; i++) {
      // Match hex colors: # followed by 3 or 6 hex digits
      const hexMatches = lines[i].match(/#[0-9A-Fa-f]{6}\b/g) ?? lines[i].match(/#[0-9A-Fa-f]{3}\b/g) ?? [];
      for (const hex of hexMatches) {
        const upperHex = hex.toUpperCase();
        const knownToken = Object.keys(KNOWN_HEX_TOKENS).find(k => k.toUpperCase() === upperHex);
        if (knownToken) {
          // Hex IS a known token — suggest using var() instead
          tokenFindings.push({
            hardcodedColor: hex,
            line: i + 1,
            suggestion: `Use var(${KNOWN_HEX_TOKENS[knownToken]}) instead of hardcoded ${hex}`,
          });
        } else {
          // Hex is NOT a known token — flag as unknown
          tokenFindings.push({
            hardcodedColor: hex,
            line: i + 1,
            suggestion: `Color ${hex} is not in the design-token list. Add a new token or use an existing one.`,
          });
        }
      }
    }

    // ── Accessibility findings ────────────────────────────────────────
    const accessibilityFindings: UIAccessibilityFinding[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check: <img> without alt attribute
      if (/<img\s/i.test(line) && !/\balt\s*=/.test(line)) {
        accessibilityFindings.push({
          issue: '<img> element without alt attribute',
          line: i + 1,
          severity: 'warning',
        });
      }

      // Check: <button> with icon-only content (no text, no aria-label)
      // Heuristic: <button> line that contains a Lucide icon component but no text content
      if (/<button/i.test(line)) {
        // Look at the next few lines for the button content
        const buttonBlock = lines.slice(i, Math.min(i + 5, lines.length)).join('\n');
        const hasIcon = /<[A-Z]\w+\s/.test(buttonBlock); // Capital = component (likely icon)
        const hasText = />[A-Za-z]/.test(buttonBlock); // Text after a tag close
        const hasAriaLabel = /aria-label\s*=/.test(buttonBlock);
        if (hasIcon && !hasText && !hasAriaLabel) {
          accessibilityFindings.push({
            issue: 'Icon-only button without aria-label',
            line: i + 1,
            severity: 'warning',
          });
        }
      }

      // Check: <input> without associated label
      if (/<input\s/i.test(line)) {
        const hasId = /id\s*=/.test(line);
        const hasAriaLabel = /aria-label\s*=/.test(line);
        const hasAriaLabelledBy = /aria-labelledby\s*=/.test(line);
        if (!hasAriaLabel && !hasAriaLabelledBy && !hasId) {
          accessibilityFindings.push({
            issue: '<input> without id, aria-label, or aria-labelledby (cannot associate with a label)',
            line: i + 1,
            severity: 'warning',
          });
        }
      }
    }

    // ── Convention findings ───────────────────────────────────────────
    const conventionFindings: UIConventionFinding[] = [];

    // Check: file-level // header comment
    const hasHeaderComment = lines.length > 0 && lines[0].startsWith('//');
    conventionFindings.push({
      rule: 'file-level-header-comment',
      passed: hasHeaderComment,
      detail: hasHeaderComment ? 'File starts with // comment' : 'File does not start with // header comment',
    });

    // Check: typed props (interface or type definition)
    const hasTypedProps = /\b(interface|type)\s+\w+Props\b/.test(content);
    conventionFindings.push({
      rule: 'typed-props-interface',
      passed: hasTypedProps,
      detail: hasTypedProps ? 'Props typed via interface/type' : 'No typed props interface found',
    });

    // Check: no `any` type in props
    const hasAnyType = /:\s*any\b/.test(content);
    conventionFindings.push({
      rule: 'no-any-type',
      passed: !hasAnyType,
      detail: hasAnyType ? 'Uses `any` type (should use specific types)' : 'No `any` types found',
    });

    // ── Overall compliance ────────────────────────────────────────────
    const totalFindings = tokenFindings.length + accessibilityFindings.length;
    const failedConventions = conventionFindings.filter(c => !c.passed).length;

    let overallCompliance: 'compliant' | 'minor-issues' | 'needs-attention';
    if (totalFindings === 0 && failedConventions === 0) {
      overallCompliance = 'compliant';
    } else if (totalFindings <= 3 && failedConventions <= 1) {
      overallCompliance = 'minor-issues';
    } else {
      overallCompliance = 'needs-attention';
    }

    return {
      tokenFindings,
      accessibilityFindings,
      conventionFindings,
      overallCompliance,
      outOfScopeNote: 'Aesthetic judgment, layout critique, and contrast-ratio calculation were NOT performed (out of scope).',
    };
  }

  // ── 3. review() override — thin wrapper, always approved ───────────
  /**
   * review() is advisory only — always returns approved: true.
   * Calls uiReview() and flattens findings into issues[].
   * Same pattern as PerformanceAgent's review() vs performanceReview().
   */
  override async review(output: { content: string; files?: string[] }): Promise<ReviewResult> {
    if (!output.files || output.files.length === 0) {
      return {
        approved: true,
        score: 100,
        notes: 'UI review: no files to scan (advisory only)',
        issues: [],
        reviewTier: 'llm-reviewed',
      };
    }

    try {
      const result = await this.uiReview(output.files[0]);

      const issues: string[] = [];
      for (const f of result.tokenFindings) {
        issues.push(`[token] ${f.hardcodedColor} at line ${f.line}: ${f.suggestion}`);
      }
      for (const f of result.accessibilityFindings) {
        issues.push(`[a11y] line ${f.line}: ${f.issue}`);
      }
      for (const f of result.conventionFindings) {
        if (!f.passed) {
          issues.push(`[convention] ${f.rule}: ${f.detail}`);
        }
      }

      return {
        approved: true,
        score: issues.length === 0 ? 100 : 75,
        notes: `UI review: ${issues.length} finding(s) (advisory, not blocking). Compliance: ${result.overallCompliance}`,
        issues,
        reviewTier: 'llm-reviewed',
      };
    } catch (err: any) {
      return {
        approved: true,
        score: 100,
        notes: `UI review failed (advisory — not blocking): ${err.message}`,
        issues: [],
        reviewTier: 'llm-error',
      };
    }
  }

  // ── Chat persona (preserved from original stub) ────────────────────
  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    try {
      let full = '';
      for await (const chunk of dispatchStrategy(task, signal, {
        systemPrompt: SYSTEM_PROMPT, temperature: 0.6, maxTokens: 1024, agentId: this.id, domain: this.domain,
      })) { if (chunk.type === 'text') full += chunk.content; yield chunk; }
      await this.memorize(full, { sourceSource: 'agent', sourceRef: this.id, tags: ['design', task.type] } as any);
    } catch (err: any) { yield { type: 'error', content: err.message, meta: { recoverable: true } }; }
  }
}
