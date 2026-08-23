import type {
  Project,
  FileNode,
  ChatSession,
  Agent,
  TerminalSession,
  EditorTab,
  Issue,
} from '@/types';

export const sampleProjects: Project[] = [
  {
    id: '1',
    name: 'E-Commerce Platform',
    lastAccessed: '2 mins ago',
    activeAgents: 5,
    completionPercent: 68,
    errorCount: 3,
    files: [],
    chats: [],
  },
  {
    id: '2',
    name: 'AI Chat App',
    lastAccessed: '1 hour ago',
    activeAgents: 3,
    completionPercent: 45,
    errorCount: 7,
    files: [],
    chats: [],
  },
  {
    id: '3',
    name: 'Portfolio Site',
    lastAccessed: '3 hours ago',
    activeAgents: 2,
    completionPercent: 92,
    errorCount: 0,
    files: [],
    chats: [],
  },
  {
    id: '4',
    name: 'API Service',
    lastAccessed: '5 hours ago',
    activeAgents: 4,
    completionPercent: 55,
    errorCount: 12,
    files: [],
    chats: [],
  },
  {
    id: '5',
    name: 'Mobile App',
    lastAccessed: '1 day ago',
    activeAgents: 6,
    completionPercent: 30,
    errorCount: 8,
    files: [],
    chats: [],
  },
  {
    id: '6',
    name: 'Data Pipeline',
    lastAccessed: '2 days ago',
    activeAgents: 2,
    completionPercent: 78,
    errorCount: 1,
    files: [],
    chats: [],
  },
];

export const sampleFileTree: FileNode[] = [
  {
    id: 'f1',
    name: 'src',
    type: 'folder',
    isOpen: true,
    children: [
      {
        id: 'f2',
        name: 'components',
        type: 'folder',
        isOpen: true,
        children: [
          { id: 'f3', name: 'Header.tsx', type: 'file', language: 'typescript', isModified: true },
          { id: 'f4', name: 'Footer.tsx', type: 'file', language: 'typescript' },
          { id: 'f5', name: 'Button.tsx', type: 'file', language: 'typescript', isModified: true },
          { id: 'f6', name: 'Card.tsx', type: 'file', language: 'typescript' },
        ],
      },
      {
        id: 'f7',
        name: 'pages',
        type: 'folder',
        isOpen: false,
        children: [
          { id: 'f8', name: 'Home.tsx', type: 'file', language: 'typescript' },
          { id: 'f9', name: 'About.tsx', type: 'file', language: 'typescript' },
          { id: 'f10', name: 'Dashboard.tsx', type: 'file', language: 'typescript', isModified: true },
        ],
      },
      {
        id: 'f11',
        name: 'hooks',
        type: 'folder',
        isOpen: false,
        children: [
          { id: 'f12', name: 'useAuth.ts', type: 'file', language: 'typescript' },
          { id: 'f13', name: 'useFetch.ts', type: 'file', language: 'typescript' },
        ],
      },
      {
        id: 'f14',
        name: 'utils',
        type: 'folder',
        isOpen: false,
        children: [
          { id: 'f15', name: 'helpers.ts', type: 'file', language: 'typescript' },
          { id: 'f16', name: 'constants.ts', type: 'file', language: 'typescript' },
        ],
      },
      { id: 'f17', name: 'App.tsx', type: 'file', language: 'typescript', isActive: true },
      { id: 'f18', name: 'main.tsx', type: 'file', language: 'typescript' },
      { id: 'f19', name: 'index.css', type: 'file', language: 'css' },
    ],
  },
  {
    id: 'f20',
    name: 'public',
    type: 'folder',
    isOpen: false,
    children: [
      { id: 'f21', name: 'index.html', type: 'file', language: 'html' },
      { id: 'f22', name: 'favicon.ico', type: 'file' },
    ],
  },
  { id: 'f23', name: 'package.json', type: 'file', language: 'json' },
  { id: 'f24', name: 'tsconfig.json', type: 'file', language: 'json' },
  { id: 'f25', name: 'tailwind.config.js', type: 'file', language: 'javascript' },
  { id: 'f26', name: 'vite.config.ts', type: 'file', language: 'typescript' },
  { id: 'f27', name: 'README.md', type: 'file', language: 'markdown' },
];

export const sampleChatSessions: ChatSession[] = [
  {
    id: '4f7e0e64-91b3-4a35-9849-d0e18ce5e3e1',
    name: 'Frontend',
    isActive: true,
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: 'Build me a responsive navigation bar with mobile hamburger menu',
        timestamp: '10:30 AM',
      },
      {
        id: 'm2',
        role: 'assistant',
        content: 'I will create a responsive navbar component for you. Let me start by examining the existing structure and then build the component.\n\nFrontend Agent is now working on:\n- Analyzing current component structure\n- Designing responsive navbar with mobile menu\n- Implementing hamburger animation\n- Adding accessibility features\n\nHere is the plan:\n1. Create Navbar.tsx with responsive breakpoints\n2. Add useState for mobile menu toggle\n3. Implement smooth CSS transitions\n4. Test on multiple viewport sizes',
        timestamp: '10:30 AM',
        agentName: 'Frontend Agent',
      },
      {
        id: 'm3',
        role: 'assistant',
        content: 'Component created successfully! I have built a fully responsive navbar with: Desktop horizontal layout, Mobile hamburger with animated transition, Backdrop blur effect, ARIA accessibility attributes, TypeScript prop types. The component is now available at src/components/Navbar.tsx. I have also updated the App.tsx to include it.',
        timestamp: '10:32 AM',
        agentName: 'Frontend Agent',
      },
    ],
  },
  {
    id: 'db3b76e4-7d12-45de-9c55-e3925b3e88ee',
    name: 'Backend',
    isActive: false,
    messages: [
      {
        id: 'm4',
        role: 'user',
        content: 'Set up authentication API with JWT tokens',
        timestamp: '9:15 AM',
      },
      {
        id: 'm5',
        role: 'assistant',
        content: 'Backend Agent is designing the auth system with JWT tokens, bcrypt password hashing, and refresh token rotation.',
        timestamp: '9:16 AM',
        agentName: 'Backend Agent',
      },
    ],
  },
  {
    id: '4b4e5473-6f7d-4b6e-9ab7-3650b4a1a9db',
    name: 'Planning',
    isActive: false,
    messages: [
      {
        id: 'm6',
        role: 'user',
        content: 'What architecture should I use for the database?',
        timestamp: 'Yesterday',
      },
      {
        id: 'm7',
        role: 'assistant',
        content: 'Architect Agent recommends PostgreSQL with Users, Products, Orders, and Inventory tables. Consider connection pooling with PgBouncer and read replicas for scaling.',
        timestamp: 'Yesterday',
        agentName: 'Architect Agent',
      },
    ],
  },
];

export const sampleAgents: Agent[] = [
  { id: 'a1', name: 'Architect Agent', role: 'Chief', specialization: 'System design, file structure planning, dependency mapping', trustScore: 94, status: 'working', currentTask: 'Designing database schema', icon: 'building-2', color: '#EE1C1C' },
  { id: 'a2', name: 'Frontend Agent', role: 'Specialist', specialization: 'UI components, React/Vue/Svelte, CSS animations', trustScore: 91, status: 'working', currentTask: 'Building Navbar component', icon: 'layout', color: '#3B82F6' },
  { id: 'a3', name: 'Backend Agent', role: 'Specialist', specialization: 'REST/GraphQL APIs, business logic, middleware', trustScore: 88, status: 'working', currentTask: 'Setting up auth API', icon: 'server', color: '#22C55E' },
  { id: 'a4', name: 'Database Agent', role: 'Specialist', specialization: 'Schema design, query optimisation, migrations', trustScore: 85, status: 'idle', currentTask: undefined, icon: 'database', color: '#F59E0B' },
  { id: 'a5', name: 'Security Agent', role: 'Analyst', specialization: 'Vulnerability scanning, dependency audits', trustScore: 96, status: 'reviewing', currentTask: 'Auditing dependencies', icon: 'shield', color: '#EE1C1C' },
  { id: 'a6', name: 'DevOps Agent', role: 'Engineer', specialization: 'CI/CD pipelines, Docker, cloud deployment', trustScore: 82, status: 'idle', currentTask: undefined, icon: 'cloud', color: '#8B5CF6' },
  { id: 'a7', name: 'QA Tester Agent', role: 'Engineer', specialization: 'Unit tests, integration tests, E2E tests', trustScore: 79, status: 'idle', currentTask: undefined, icon: 'test-tube', color: '#EC4899' },
  { id: 'a8', name: 'Documentation Agent', role: 'Writer', specialization: 'README files, API documentation, changelogs', trustScore: 87, status: 'idle', currentTask: undefined, icon: 'file-text', color: '#14B8A6' },
  { id: 'a9', name: 'Performance Agent', role: 'Engineer', specialization: 'Bundle size, memory profiling, Lighthouse', trustScore: 83, status: 'idle', currentTask: undefined, icon: 'gauge', color: '#F97316' },
  { id: 'a10', name: 'Terminal Agent', role: 'Manager', specialization: 'Command execution, output analysis', trustScore: 90, status: 'idle', currentTask: undefined, icon: 'terminal', color: '#64748B' },
  { id: 'a11', name: 'Memory Agent', role: 'Core', specialization: 'RAG index, Knowledge Vault, semantic search', trustScore: 93, status: 'working', currentTask: 'Indexing project files', icon: 'brain', color: '#A855F7' },
  { id: 'a12', name: 'UI Designer Agent', role: 'Creative', specialization: 'Visual design, color systems, animation', trustScore: 86, status: 'idle', currentTask: undefined, icon: 'palette', color: '#E11D48' },
  { id: 'a13', name: 'Extension Agent', role: 'Manager', specialization: 'Extension health, conflict resolution', trustScore: 78, status: 'idle', currentTask: undefined, icon: 'puzzle', color: '#06B6D4' },
  { id: 'a14', name: 'Research Agent', role: 'Specialist', specialization: 'Documentation lookup, library research', trustScore: 81, status: 'idle', currentTask: undefined, icon: 'search', color: '#84CC16' },
  { id: 'a15', name: 'Deployment Agent', role: 'Specialist', specialization: 'Platform config, environment setup', trustScore: 84, status: 'idle', currentTask: undefined, icon: 'rocket', color: '#D946EF' },
  { id: 'a16', name: 'Prompt Engineer', role: 'Specialist', specialization: 'System prompt refinement, AI behaviour tuning', trustScore: 89, status: 'idle', currentTask: undefined, icon: 'message-square', color: '#6366F1' },
  { id: 'a17', name: 'Code Review Agent', role: 'Core', specialization: 'Quality scoring, anti-pattern detection', trustScore: 95, status: 'reviewing', currentTask: 'Reviewing AI-generated code', icon: 'eye', color: '#EE1C1C' },
  // Personal-Pillar agents (directive Section 3 — added progressively per build step)
  { id: 'a18', name: 'Fabrication Agent', role: 'Specialist', specialization: 'Parametric CAD generation (build123d), STL export, slicer/printer handoff (Step 5+)', trustScore: 75, status: 'idle', currentTask: undefined, icon: 'box', color: '#10B981' },
  { id: 'a19', name: 'Operative Agent', role: 'Specialist', specialization: 'Autonomous browser automation (Playwright), smart-home device control (Step 7+)', trustScore: 72, status: 'idle', currentTask: undefined, icon: 'globe', color: '#F59E0B' },
  { id: 'a20', name: 'Sentinel Agent', role: 'Core', specialization: 'Continuous ambient monitoring — reuses Ghost Mode FSM for life/ambient signals', trustScore: 70, status: 'idle', currentTask: undefined, icon: 'eye', color: '#8B5CF6' },
];

export const sampleTerminalSessions: TerminalSession[] = [
  {
    id: 't1',
    name: 'bash',
    shell: 'bash',
    isActive: true,
    history: [
      { id: 'tl1', type: 'system', content: 'Zero Two Terminal v4.0', timestamp: '10:30:00' },
      { id: 'tl2', type: 'input', content: 'npm install @monaco-editor/react motion/react', timestamp: '10:30:15' },
      { id: 'tl3', type: 'output', content: 'added 42 packages in 3.2s\n\n13 packages are looking for funding', timestamp: '10:30:18' },
      { id: 'tl4', type: 'input', content: 'git status', timestamp: '10:31:00' },
      { id: 'tl5', type: 'output', content: 'On branch main\nYour branch is up to date with origin/main.\n\nChanges not staged for commit:\n  modified: src/components/Header.tsx\n  modified: src/components/Button.tsx\n  modified: src/pages/Dashboard.tsx', timestamp: '10:31:01' },
      { id: 'tl6', type: 'input', content: 'npm run dev', timestamp: '10:32:00' },
      { id: 'tl7', type: 'output', content: 'VITE v5.0.0 ready in 420 ms\n\n  Local: http://localhost:5173/\n  Network: http://192.168.1.100:5173/', timestamp: '10:32:01' },
    ],
  },
  {
    id: 't2',
    name: 'node',
    shell: 'node',
    isActive: false,
    history: [
      { id: 'tl8', type: 'system', content: 'Node.js v20.10.0', timestamp: '10:25:00' },
      { id: 'tl9', type: 'input', content: 'console.log("Hello from Zero Two")', timestamp: '10:25:10' },
      { id: 'tl10', type: 'output', content: 'Hello from Zero Two\nundefined', timestamp: '10:25:10' },
    ],
  },
];

export const sampleEditorTabs: EditorTab[] = [
  { fileId: 'f17', fileName: 'App.tsx', language: 'typescript', isModified: false, isActive: true },
  { fileId: 'f3', fileName: 'Header.tsx', language: 'typescript', isModified: true, isActive: false },
  { fileId: 'f5', fileName: 'Button.tsx', language: 'typescript', isModified: true, isActive: false },
  { fileId: 'f10', fileName: 'Dashboard.tsx', language: 'typescript', isModified: true, isActive: false },
];

export const sampleFileContent: Record<string, string> = {
  'f17': `import { useState } from 'react';
import { Header } from './components/Header';
import { Footer } from './components/Footer';
import { Button } from './components/Button';
import { Card } from './components/Card';

function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="min-h-screen bg-void">
      <Header title="Zero Two Platform" />
      <main className="container mx-auto py-8">
        <h1 className="text-3xl font-bold text-silver mb-4">
          Welcome to Code Siren
        </h1>
        <Card>
          <p className="text-steel mb-4">
            Count: {count}
          </p>
          <Button 
            onClick={() => setCount(c => c + 1)}
            variant="primary"
          >
            Increment
          </Button>
        </Card>
      </main>
      <Footer />
    </div>
  );
}

export default App;`,
  'f3': `import { useState } from 'react';

interface HeaderProps {
  title: string;
}

export function Header({ title }: HeaderProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  return (
    <header className="bg-surface border-b border-subtle">
      <div className="container mx-auto px-4 py-3 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-silver">
          {title}
        </h1>
        <nav className="hidden md:flex gap-4">
          <a href="/" className="text-steel hover:text-silver transition-colors">
            Home
          </a>
          <a href="/about" className="text-steel hover:text-silver transition-colors">
            About
          </a>
          <a href="/dashboard" className="text-steel hover:text-silver transition-colors">
            Dashboard
          </a>
        </nav>
        <button 
          className="md:hidden p-2"
          onClick={() => setIsMenuOpen(!isMenuOpen)}
          aria-label="Toggle menu"
        >
          <div className="w-5 h-0.5 bg-silver mb-1" />
          <div className="w-5 h-0.5 bg-silver mb-1" />
          <div className="w-5 h-0.5 bg-silver" />
        </button>
      </div>
    </header>
  );
}`,
  'f5': `import { ReactNode } from 'react';

interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  size = 'md',
  disabled = false,
}: ButtonProps) {
  const baseStyles = 'rounded-md font-medium transition-all duration-150';
  
  const variantStyles = {
    primary: 'bg-siren text-white hover:bg-active-red',
    secondary: 'bg-surface-raised text-silver border border-subtle',
    ghost: 'text-steel hover:text-silver',
  };
  
  const sizeStyles = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2 text-sm',
    lg: 'px-6 py-3 text-base',
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={\`\${baseStyles} \${variantStyles[variant]} \${sizeStyles[size]} \${disabled ? 'opacity-50' : ''}\`}
    >
      {children}
    </button>
  );
}`,
  'f10': `import { useState, useEffect } from 'react';
import { Card } from '../components/Card';

interface DashboardStats {
  totalUsers: number;
  activeUsers: number;
  revenue: number;
  growth: number;
}

export function Dashboard() {
  const [stats, setStats] = useState<DashboardStats>({
    totalUsers: 0,
    activeUsers: 0,
    revenue: 0,
    growth: 0,
  });

  useEffect(() => {
    fetch('/api/stats')
      .then(res => res.json())
      .then(data => setStats(data))
      .catch(console.error);
  }, []);

  return (
    <div className="p-6 space-y-6">
      <h2 className="text-2xl font-bold text-silver">
        Dashboard
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="p-4">
          <p className="text-sm text-steel">Total Users</p>
          <p className="text-2xl font-bold text-silver">
            {stats.totalUsers}
          </p>
        </Card>
      </div>
    </div>
  );
}`,
};

export const issues: Issue[] = [
  { id: 'i1', type: 'error', message: 'Cannot find module', file: 'src/App.tsx', line: 3 },
  { id: 'i2', type: 'warning', message: 'useEffect is defined but never used', file: 'src/pages/Home.tsx', line: 1 },
  { id: 'i3', type: 'warning', message: 'Unexpected any. Specify a different type', file: 'src/hooks/useAuth.ts', line: 15 },
  { id: 'i4', type: 'error', message: 'Property onClick does not exist', file: 'src/components/Button.tsx', line: 23 },
  { id: 'i5', type: 'info', message: 'Consider adding a type annotation', file: 'src/utils/helpers.ts', line: 8 },
];
