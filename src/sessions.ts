import * as crypto from "node:crypto";

export type SessionStatus = "INITIALIZING" | "DRAFTING" | "STALLED_RFI" | "SYNTHESIZING" | "COMPLETED";

export interface CouncilMemberResponse {
  model: string;
  content: string;
  confidence?: string; 
  reasoning?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  error?: string;
}

export interface CouncilSession {
  id: string;
  projectHash: string;
  query: string;
  sharedContext: string;
  targetedContext: Record<string, string[]>; // model -> array of context strings
  status: SessionStatus;
  rfiRoundCount: number;
  models: string[];
  lastAccessed: number;
  drafts: CouncilMemberResponse[];
  reviews: CouncilMemberResponse[];
  consensusScore: number; // 1-10 scale
  reasoningEffort: "none" | "low" | "medium" | "high";
  requestedPaths: string[]; // Track historical RFIs to prevent loops
  persona?: string;
}

const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

export class SessionStore {
  private sessions = new Map<string, CouncilSession>();

  constructor() {
    // Background cleanup
    setInterval(() => this.cleanup(), 60000); // Every minute
  }

  private getProjectHash(projectPath: string): string {
    return crypto.createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
  }

  private getSessionKey(projectPath: string, sessionId: string): string {
    return `${this.getProjectHash(projectPath)}:${sessionId}`;
  }

  createSession(projectPath: string, query: string, models: string[], reasoningEffort: "none" | "low" | "medium" | "high" = "none"): CouncilSession {
    const sessionId = crypto.randomUUID();
    const projectHash = this.getProjectHash(projectPath);
    const session: CouncilSession = {
      id: sessionId,
      projectHash,
      query,
      sharedContext: "",
      targetedContext: {},
      status: "INITIALIZING",
      rfiRoundCount: 0,
      models,
      reasoningEffort,
      lastAccessed: Date.now(),
      drafts: [],
      reviews: [],
      consensusScore: 0,
      requestedPaths: []
    };

    this.sessions.set(this.getSessionKey(projectPath, sessionId), session);
    return session;
  }

  getSession(projectPath: string, sessionId: string): CouncilSession | undefined {
    const key = this.getSessionKey(projectPath, sessionId);
    const session = this.sessions.get(key);
    if (session) {
      session.lastAccessed = Date.now();
    }
    return session;
  }

  deleteSession(projectPath: string, sessionId: string): void {
    this.sessions.delete(this.getSessionKey(projectPath, sessionId));
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastAccessed > SESSION_TTL_MS) {
        this.sessions.delete(key);
      }
    }
  }
}

export const sessionStore = new SessionStore();