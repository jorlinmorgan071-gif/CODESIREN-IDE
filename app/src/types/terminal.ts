// Terminal event payload types (shared between server + client)

export interface TerminalReadyPayload {
  sessionId: string;
  buffer?: string;
}

export interface TerminalOutputPayload {
  sessionId: string;
  data: string;
}

export interface TerminalSuggestPayload {
  command: string;
}

export interface TerminalInputPayload {
  sessionId: string;
  data: string;
}

export interface TerminalResizePayload {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface TerminalKillPayload {
  sessionId: string;
}
