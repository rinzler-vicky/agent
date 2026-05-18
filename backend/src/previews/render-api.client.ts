import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const RENDER_API_BASE = 'https://api.render.com/v1';

export interface RenderService {
  id: string;
  name: string;
  type: string;
  serviceDetails?: { url?: string };
  suspended?: string;
}

export interface RenderEnvVar {
  key: string;
  value: string;
}

export interface RenderCreateServiceInput {
  name: string;
  ownerId: string;
  type: 'web_service' | 'private_service' | 'background_worker' | 'cron_job' | 'static_site';
  repo: string;
  branch: string;
  envVars?: RenderEnvVar[];
  serviceDetails?: Record<string, unknown>;
  rootDir?: string;
  autoDeploy?: 'yes' | 'no';
}

/**
 * Minimal wrapper over the Render REST API. Used by:
 *  - AgentPreviewSpawnerService: create the backend service for an
 *    agent-initiated preview (cannot spawn keyvalue/n8n services — those
 *    only exist via Blueprint).
 *  - PreviewTtlService: delete agent-spawned services on expiry.
 *
 * Auth: `Authorization: Bearer ${RENDER_API_KEY}`.
 *
 * Endpoint shapes verified against https://api-docs.render.com (May 2026):
 *   POST   /v1/services
 *   GET    /v1/services?name=...&includePreviews=true
 *   GET    /v1/services/{id}
 *   DELETE /v1/services/{id}
 *   PUT    /v1/services/{id}/env-vars
 *   POST   /v1/services/{id}/deploys
 *
 * Note: the `type` enum on POST does NOT include `keyvalue`/`redis` — those
 * are Blueprint-only and cannot be spawned programmatically (one of the
 * load-bearing constraints documented in Phase 2.5b ADR notes).
 */
@Injectable()
export class RenderApiClient {
  private readonly logger = new Logger(RenderApiClient.name);
  private readonly apiKey: string;
  private readonly ownerId: string;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.apiKey = config.get<string>('RENDER_API_KEY') ?? '';
    this.ownerId = config.get<string>('RENDER_OWNER_ID') ?? '';
  }

  async createService(input: RenderCreateServiceInput): Promise<RenderService> {
    this.assertConfigured();
    const body = { ...input, ownerId: input.ownerId || this.ownerId };
    const res = await fetch(`${RENDER_API_BASE}/services`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await safeReadText(res);
      throw new Error(`Render createService failed: HTTP ${res.status}: ${txt}`);
    }
    // The create-service endpoint returns `{ service: {...}, deployId }` —
    // the service wrapper holds the service object.
    const data = (await res.json()) as { service?: RenderService } & RenderService;
    return data.service ?? (data as RenderService);
  }

  async getService(id: string): Promise<RenderService | null> {
    this.assertConfigured();
    const res = await fetch(`${RENDER_API_BASE}/services/${id}`, { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) {
      const txt = await safeReadText(res);
      throw new Error(`Render getService failed: HTTP ${res.status}: ${txt}`);
    }
    return (await res.json()) as RenderService;
  }

  async deleteService(id: string): Promise<void> {
    this.assertConfigured();
    const res = await fetch(`${RENDER_API_BASE}/services/${id}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 404) {
      const txt = await safeReadText(res);
      throw new Error(`Render deleteService failed: HTTP ${res.status}: ${txt}`);
    }
  }

  async putEnvVars(id: string, envVars: RenderEnvVar[]): Promise<void> {
    this.assertConfigured();
    const res = await fetch(`${RENDER_API_BASE}/services/${id}/env-vars`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(envVars),
    });
    if (!res.ok) {
      const txt = await safeReadText(res);
      throw new Error(`Render putEnvVars failed: HTTP ${res.status}: ${txt}`);
    }
  }

  /**
   * Poll `getService` until `serviceDetails.url` is non-empty, with a hard
   * cap. Returns the resolved URL. Mirror of pr-preview.yml lines 203-234.
   */
  async waitForServiceUrl(id: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? 180_000;
    const intervalMs = opts.intervalMs ?? 5_000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const svc = await this.getService(id);
      const url = svc?.serviceDetails?.url;
      if (url) return url;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Render waitForServiceUrl timed out after ${timeoutMs}ms for service ${id}`);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  private assertConfigured(): void {
    if (!this.apiKey) {
      throw new Error('RENDER_API_KEY must be set');
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
