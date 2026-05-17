import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { N8nWorkflow } from './types';

export interface N8nWorkflowResponse {
  id: string;
  name: string;
  active: boolean;
  versionId: string;
  nodes: N8nWorkflow['nodes'];
  connections: N8nWorkflow['connections'];
  settings: N8nWorkflow['settings'];
}

export interface N8nExecutionResponse {
  id: string;
  finished: boolean;
  mode: string;
  startedAt: string;
  stoppedAt?: string;
  workflowId: string;
  status?: string;
  data?: unknown;
}

export class N8nApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
    message: string,
  ) {
    super(message);
    this.name = 'N8nApiError';
  }
}

const DEFAULT_TIMEOUT_MS = 5000;

@Injectable()
export class N8nApiClient {
  private readonly logger = new Logger(N8nApiClient.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly reconcileTimeoutMs: number;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.baseUrl = (config.get<string>('N8N_API_URL') ?? '').replace(/\/+$/, '');
    this.apiKey = config.get<string>('N8N_API_KEY') ?? '';
    this.reconcileTimeoutMs = Number(
      config.get<string>('N8N_RECONCILE_TIMEOUT_MS') ?? '2000',
    );
  }

  async createWorkflow(body: N8nWorkflow): Promise<N8nWorkflowResponse> {
    return this.request<N8nWorkflowResponse>('POST', '/workflows', body);
  }

  async updateWorkflow(id: string, body: N8nWorkflow): Promise<N8nWorkflowResponse> {
    return this.request<N8nWorkflowResponse>('PUT', `/workflows/${id}`, body);
  }

  async getWorkflow(id: string): Promise<N8nWorkflowResponse | null> {
    try {
      return await this.request<N8nWorkflowResponse>('GET', `/workflows/${id}`);
    } catch (err) {
      if (err instanceof N8nApiError && err.status === 404) return null;
      throw err;
    }
  }

  async activateWorkflow(id: string): Promise<void> {
    await this.request<unknown>('POST', `/workflows/${id}/activate`);
  }

  async deactivateWorkflow(id: string): Promise<void> {
    await this.request<unknown>('POST', `/workflows/${id}/deactivate`);
  }

  async deleteWorkflow(id: string): Promise<void> {
    await this.request<unknown>('DELETE', `/workflows/${id}`);
  }

  async getExecution(id: string): Promise<N8nExecutionResponse | null> {
    try {
      return await this.request<N8nExecutionResponse>(
        'GET',
        `/executions/${id}?includeData=true`,
        undefined,
        this.reconcileTimeoutMs,
      );
    } catch (err) {
      if (err instanceof N8nApiError && err.status === 404) return null;
      throw err;
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'X-N8N-API-KEY': this.apiKey,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new N8nApiError(res.status, text, `n8n ${method} ${path} -> ${res.status}`);
    }
    return (text ? JSON.parse(text) : ({} as T)) as T;
  }
}
