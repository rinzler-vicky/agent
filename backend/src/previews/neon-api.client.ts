import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const NEON_API_BASE = 'https://console.neon.tech/api/v2';

export interface NeonBranch {
  id: string;
  name: string;
  parent_id?: string;
}

export interface NeonBranchEndpoint {
  id: string;
  host: string;
}

export interface NeonCreateBranchResult {
  branch: NeonBranch;
  /** Postgres connection URI for the new branch's default role. */
  connection_uri: string;
}

/**
 * Minimal wrapper over the Neon Console v2 API for branch lifecycle. Used by
 * AgentPreviewSpawnerService; PR-driven previews continue to use the
 * `neondatabase/create-branch-action@v6` GitHub Action in pr-preview.yml.
 *
 * Auth: `Authorization: Bearer ${NEON_API_KEY}`. Project scoping via
 * `NEON_PROJECT_ID` — same env vars the GitHub Action consumes.
 *
 * Errors: the client throws on non-2xx with the response body in the message
 * for actionable log lines. Callers (the spawner) catch and mark the
 * preview_environments row `status='failed'` rather than retry.
 */
@Injectable()
export class NeonApiClient {
  private readonly logger = new Logger(NeonApiClient.name);
  private readonly apiKey: string;
  private readonly projectId: string;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.apiKey = config.get<string>('NEON_API_KEY') ?? '';
    this.projectId = config.get<string>('NEON_PROJECT_ID') ?? '';
  }

  /**
   * Create a branch off the project's default branch (production). The Neon
   * API also creates a default read-write endpoint so the returned URI is
   * immediately usable.
   */
  async createBranch(name: string): Promise<NeonCreateBranchResult> {
    this.assertConfigured();
    const res = await fetch(`${NEON_API_BASE}/projects/${this.projectId}/branches`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        branch: { name },
        endpoints: [{ type: 'read_write' }],
      }),
    });
    if (!res.ok) {
      const body = await safeReadText(res);
      throw new Error(`Neon createBranch failed: HTTP ${res.status}: ${body}`);
    }
    const data = (await res.json()) as {
      branch: NeonBranch;
      connection_uris?: Array<{ connection_uri: string }>;
    };
    const connection_uri = data.connection_uris?.[0]?.connection_uri;
    if (!connection_uri) {
      throw new Error('Neon createBranch returned no connection_uri');
    }
    return { branch: data.branch, connection_uri };
  }

  async deleteBranch(branchId: string): Promise<void> {
    this.assertConfigured();
    const res = await fetch(
      `${NEON_API_BASE}/projects/${this.projectId}/branches/${branchId}`,
      { method: 'DELETE', headers: this.headers() },
    );
    if (!res.ok && res.status !== 404) {
      const body = await safeReadText(res);
      throw new Error(`Neon deleteBranch failed: HTTP ${res.status}: ${body}`);
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  private assertConfigured(): void {
    if (!this.apiKey || !this.projectId) {
      throw new Error('NEON_API_KEY and NEON_PROJECT_ID must be set');
    }
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<no body>';
  }
}
