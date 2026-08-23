import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { resolveWorkspacePath, workspaceRelativePath, type WorkspaceIdentity } from '../workspace/service.js';

const TEST_FILE_RE = /\.test\.tsx?$/;
const TYPESCRIPT_FILE_RE = /\.tsx?$/;
export type ImpactAnalysisStatus = 'available' | 'not-applicable' | 'unavailable';

export interface ImpactSymbol {
  name: string;
  kind: string;
  start: number;
  end: number;
}

export interface ImpactDependent {
  path: string;
  importedNames: string[];
  evidence: 'typescript-module-resolution';
}

export interface ImpactRoute {
  method: string;
  path: string;
  modulePath: string;
  evidence: 'express-static-route';
}

export interface ImpactTest {
  path: string;
  evidence: 'typescript-module-resolution' | 'adjacent-test-file';
}

export interface PlannedVerification {
  packagePath: string;
  command: string;
  reason: string;
  status: 'planned';
}

export interface ChangeImpactAnalysis {
  status: ImpactAnalysisStatus;
  changedRange: { start: number; end: number };
  symbols: ImpactSymbol[];
  dependents: ImpactDependent[];
  routes: ImpactRoute[];
  tests: ImpactTest[];
  verification: PlannedVerification[];
  confidence: 'direct-static-evidence' | 'not-applicable' | 'unavailable';
  gaps: string[];
  reason?: string;
}

export interface ChangeImpactInput {
  workspace: WorkspaceIdentity;
  path: string;
  before: string;
  after: string;
}

interface LoadedProgram {
  program: ts.Program;
  options: ts.CompilerOptions;
}

function toWorkspacePath(workspace: WorkspaceIdentity, filePath: string): string {
  return relative(workspace.rootPath, filePath).split('\\').join('/');
}

function changedRange(before: string, after: string): { start: number; end: number } {
  let prefix = 0;
  const shortest = Math.min(before.length, after.length);
  while (prefix < shortest && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;

  return { start: prefix, end: before.length - suffix };
}

function findNearestTsconfig(workspace: WorkspaceIdentity, absolutePath: string): string | undefined {
  let directory = dirname(absolutePath);
  const root = resolve(workspace.rootPath);
  while (directory === root || directory.startsWith(`${root}/`)) {
    const candidate = join(directory, 'tsconfig.json');
    if (existsSync(candidate)) return candidate;
    if (directory === root) break;
    directory = dirname(directory);
  }
  return undefined;
}

function loadProgram(tsconfigPath: string): LoadedProgram {
  const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(tsconfigPath), undefined, tsconfigPath);
  const fatal = parsed.errors.find((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (fatal) throw new Error(ts.flattenDiagnosticMessageText(fatal.messageText, '\n'));
  return {
    program: ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options }),
    options: parsed.options,
  };
}

function sourceFileFor(program: ts.Program, absolutePath: string): ts.SourceFile | undefined {
  const normalized = resolve(absolutePath);
  return program.getSourceFiles().find((sourceFile) => resolve(sourceFile.fileName) === normalized);
}

function declarationKind(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isVariableDeclaration(node)) return 'variable';
  return undefined;
}

function changedSymbols(sourceFile: ts.SourceFile, range: { start: number; end: number }): ImpactSymbol[] {
  const symbols: ImpactSymbol[] = [];
  const visit = (node: ts.Node) => {
    const kind = declarationKind(node);
    const named = node as ts.NamedDeclaration;
    if (kind && named.name && ts.isIdentifier(named.name) && node.getStart(sourceFile) <= range.end && node.getEnd() >= range.start) {
      symbols.push({
        name: named.name.text,
        kind,
        start: node.getStart(sourceFile),
        end: node.getEnd(),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return symbols.sort((left, right) => left.start - right.start || left.name.localeCompare(right.name));
}

function changedAfterRange(before: string, after: string): { start: number; end: number } {
  let prefix = 0;
  const shortest = Math.min(before.length, after.length);
  while (prefix < shortest && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;

  return { start: prefix, end: after.length - suffix };
}

function changedSymbolsAcrossBaselineAndProposal(
  baseline: ts.SourceFile,
  proposalPath: string,
  before: string,
  after: string,
): ImpactSymbol[] {
  const proposed = ts.createSourceFile(proposalPath, after, ts.ScriptTarget.Latest, true);
  const symbols = [
    ...changedSymbols(baseline, changedRange(before, after)),
    ...changedSymbols(proposed, changedAfterRange(before, after)),
  ]
    .filter((symbol, index, all) => all.findIndex((candidate) => candidate.name === symbol.name && candidate.kind === symbol.kind) === index)
    .sort((left, right) => left.start - right.start || left.name.localeCompare(right.name));
  return symbols.length > 0
    ? symbols
    : [{ name: '(module surface)', kind: 'module', start: changedRange(before, after).start, end: changedRange(before, after).end }];
}

function importEvidence(statement: ts.Statement): { specifier: string; names: string[] } | undefined {
  if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
    const names: string[] = [];
    const clause = statement.importClause;
    if (clause?.name) names.push('default');
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      names.push(...clause.namedBindings.elements.map((element) => element.propertyName?.text ?? element.name.text));
    }
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.push('*');
    return { specifier: statement.moduleSpecifier.text, names: names.sort() };
  }
  if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
    const names = statement.exportClause && ts.isNamedExports(statement.exportClause)
      ? statement.exportClause.elements.map((element) => element.propertyName?.text ?? element.name.text).sort()
      : ['*'];
    return { specifier: statement.moduleSpecifier.text, names };
  }
  return undefined;
}

function findDirectDependents(workspace: WorkspaceIdentity, program: ts.Program, options: ts.CompilerOptions, absolutePath: string): ImpactDependent[] {
  const target = resolve(absolutePath);
  const dependents: ImpactDependent[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || resolve(sourceFile.fileName) === target || !resolve(sourceFile.fileName).startsWith(resolve(workspace.rootPath))) continue;
    const names = new Set<string>();
    for (const statement of sourceFile.statements) {
      const evidence = importEvidence(statement);
      if (!evidence) continue;
      const resolved = ts.resolveModuleName(evidence.specifier, sourceFile.fileName, options, ts.sys).resolvedModule?.resolvedFileName;
      if (resolved && resolve(resolved) === target) evidence.names.forEach((name) => names.add(name));
    }
    if (names.size > 0) {
      dependents.push({
        path: toWorkspacePath(workspace, sourceFile.fileName),
        importedNames: [...names].sort(),
        evidence: 'typescript-module-resolution',
      });
    }
  }
  return dependents.sort((left, right) => left.path.localeCompare(right.path));
}

function discoverAdjacentTests(workspace: WorkspaceIdentity, absolutePath: string): ImpactTest[] {
  const extension = extname(absolutePath);
  const stem = absolutePath.slice(0, -extension.length);
  const candidates = [`${stem}.test.ts`, `${stem}.test.tsx`];
  return candidates
    .filter((candidate) => existsSync(candidate))
    .map((candidate) => ({ path: toWorkspacePath(workspace, candidate), evidence: 'adjacent-test-file' as const }));
}

function discoverRoutes(workspace: WorkspaceIdentity, files: string[]): ImpactRoute[] {
  const routes: ImpactRoute[] = [];
  const indexPath = join(workspace.rootPath, 'server', 'src', 'index.ts');
  const indexContent = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
  for (const file of files) {
    const workspacePath = toWorkspacePath(workspace, file);
    if (!workspacePath.startsWith('server/src/routes/') || !existsSync(file)) continue;
    const routerName = `${basename(file, '.ts').replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())}Router`;
    const mount = new RegExp(`app\\.use\\(['\"]([^'\"]+)['\"],\\s*${routerName}\\)`).exec(indexContent)?.[1] ?? '';
    const content = readFileSync(file, 'utf8');
    const routePattern = /\.(get|post|put|patch|delete)\(['\"]([^'\"]+)['\"]/g;
    for (const match of content.matchAll(routePattern)) {
      const suffix = match[2] === '/' ? '' : match[2];
      routes.push({
        method: match[1].toUpperCase(),
        path: `${mount}${suffix}` || '/',
        modulePath: workspacePath,
        evidence: 'express-static-route',
      });
    }
  }
  return routes.sort((left, right) => `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`));
}

function findPackageRoot(workspace: WorkspaceIdentity, absolutePath: string): string | undefined {
  let directory = dirname(absolutePath);
  const root = resolve(workspace.rootPath);
  while (directory === root || directory.startsWith(`${root}/`)) {
    if (existsSync(join(directory, 'package.json'))) return directory;
    if (directory === root) break;
    directory = dirname(directory);
  }
  return undefined;
}

function loadPackageScripts(packagePath: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

function verificationPlan(workspace: WorkspaceIdentity, absolutePath: string, tests: ImpactTest[]): PlannedVerification[] {
  const plans: PlannedVerification[] = [];
  const owner = findPackageRoot(workspace, absolutePath);
  if (owner && loadPackageScripts(owner).typecheck) {
    plans.push({
      packagePath: toWorkspacePath(workspace, owner) || '.',
      command: 'npm run typecheck',
      reason: 'Changed TypeScript surface requires the owning package typecheck',
      status: 'planned',
    });
  }

  const testsByPackage = new Map<string, string[]>();
  for (const test of tests) {
    const testPath = resolve(workspace.rootPath, test.path);
    const packagePath = findPackageRoot(workspace, testPath);
    if (!packagePath || !loadPackageScripts(packagePath).test) continue;
    const relativeTestPath = relative(packagePath, testPath).split('\\').join('/');
    testsByPackage.set(packagePath, [...(testsByPackage.get(packagePath) ?? []), relativeTestPath]);
  }
  for (const [packagePath, paths] of [...testsByPackage.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    plans.push({
      packagePath: toWorkspacePath(workspace, packagePath) || '.',
      command: `npm test -- ${[...new Set(paths)].sort().join(' ')}`,
      reason: 'Compiler-resolved or adjacent tests cover the changed surface',
      status: 'planned',
    });
  }
  return plans;
}

function notApplicable(before: string, after: string, reason: string): ChangeImpactAnalysis {
  return {
    status: 'not-applicable',
    changedRange: changedRange(before, after),
    symbols: [],
    dependents: [],
    routes: [],
    tests: [],
    verification: [],
    confidence: 'not-applicable',
    gaps: ['TypeScript compiler analysis applies only to .ts and .tsx files.'],
    reason,
  };
}

export function analyzeChangeImpact(input: ChangeImpactInput): ChangeImpactAnalysis {
  const absolutePath = resolveWorkspacePath(input.workspace, input.path, { mustExist: true });
  const relativePath = workspaceRelativePath(input.workspace, input.path);
  if (!TYPESCRIPT_FILE_RE.test(absolutePath)) {
    return notApplicable(input.before, input.after, 'Changed file is not TypeScript; no TypeScript impact graph was claimed');
  }
  const tsconfigPath = findNearestTsconfig(input.workspace, absolutePath);
  if (!tsconfigPath) {
    return {
      ...notApplicable(input.before, input.after, 'No in-workspace tsconfig.json was found for the changed file'),
      status: 'unavailable',
      confidence: 'unavailable',
      gaps: ['TypeScript impact analysis requires an in-workspace tsconfig.json.'],
    };
  }

  try {
    const { program, options } = loadProgram(tsconfigPath);
    const sourceFile = sourceFileFor(program, absolutePath);
    if (!sourceFile) {
      return {
        ...notApplicable(input.before, input.after, 'Changed file is excluded from the nearest TypeScript program'),
        status: 'unavailable',
        confidence: 'unavailable',
        gaps: ['The changed TypeScript file is not included by its nearest tsconfig.json.'],
      };
    }
    const range = changedRange(input.before, input.after);
    const dependents = findDirectDependents(input.workspace, program, options, absolutePath);
    const dependentPaths = dependents.map((dependent) => resolve(input.workspace.rootPath, dependent.path));
    const compilerTests = dependents
      .filter((dependent) => TEST_FILE_RE.test(dependent.path))
      .map((dependent) => ({ path: dependent.path, evidence: 'typescript-module-resolution' as const }));
    const directTest = TEST_FILE_RE.test(relativePath)
      ? [{ path: relativePath, evidence: 'typescript-module-resolution' as const }]
      : [];
    const tests = [...compilerTests, ...directTest, ...discoverAdjacentTests(input.workspace, absolutePath)]
      .filter((test, index, all) => all.findIndex((candidate) => candidate.path === test.path) === index)
      .sort((left, right) => left.path.localeCompare(right.path));
    const routeFiles = [absolutePath, ...dependentPaths];

    return {
      status: 'available',
      changedRange: range,
      symbols: changedSymbolsAcrossBaselineAndProposal(sourceFile, absolutePath, input.before, input.after),
      dependents,
      routes: discoverRoutes(input.workspace, routeFiles),
      tests,
      verification: verificationPlan(input.workspace, absolutePath, tests),
      confidence: 'direct-static-evidence',
      gaps: [
        'Dynamic imports, require calls, generated code, reflection, and runtime-only route registration are not inferred.',
        'Verification entries are declared plans; they are not execution results.',
      ],
    };
  } catch (error) {
    return {
      ...notApplicable(input.before, input.after, 'TypeScript compiler analysis could not be constructed'),
      status: 'unavailable',
      confidence: 'unavailable',
      gaps: ['TypeScript compiler analysis failed closed and no dependent or verification claim was produced.'],
      reason: error instanceof Error ? error.message : 'TypeScript compiler analysis could not be constructed',
    };
  }
}

export const __test__ = {
  changedRange,
  changedAfterRange,
  findNearestTsconfig,
};
