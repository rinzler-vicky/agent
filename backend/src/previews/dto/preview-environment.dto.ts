/**
 * DTO mirroring the `preview_environments` table (migration 014). Used as
 * the typed row shape for internal services; not (yet) exposed via a public
 * controller — agent-initiated previews are managed entirely server-side.
 */
export type PreviewSource = 'pr' | 'agent_failure_recovery';

export type PreviewStatus =
  | 'pending'
  | 'provisioning'
  | 'ready'
  | 'failed'
  | 'expired'
  | 'torn_down';

export interface PreviewEnvironment {
  id: string;
  tenant_id: string;
  workflow_version_id: string | null;
  pr_number: number | null;
  source: PreviewSource;
  status: PreviewStatus;
  render_backend_service_id: string | null;
  render_n8n_service_id: string | null;
  neon_branch_name: string | null;
  preview_url: string | null;
  n8n_url: string | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  torn_down_at: Date | null;
}
