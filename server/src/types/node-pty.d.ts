// Minimal type declarations for node-pty (no @types/node-pty on npm).
// Based on the node-pty 1.1.0 API.

declare module 'node-pty' {
  export interface IPty {
    pid: number;
    cols: number;
    rows: number;
    process: string;
    readonly onData: (listener: (data: string) => void) => IDisposable;
    readonly onExit: (listener: (e: { exitCode: number; signal?: number }) => void) => IDisposable;
    write(data: string): void;
    resize(columns: number, rows: number): void;
    kill(signal?: string): void;
    pause(): void;
    resume(): void;
  }

  export interface IDisposable {
    dispose(): void;
  }

  export interface IPtyForkOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: { [key: string]: string | undefined };
    encoding?: string;
  }

  export function spawn(file: string, args: string[] | string, options: IPtyForkOptions): IPty;
}
