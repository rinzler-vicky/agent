# PR Preview Environments

This repository automatically deploys ephemeral preview environments for every Pull Request that enters "ready for review" status. Preview environments allow reviewers and stakeholders to test changes in an isolated environment before merging to production.

## How It Works

### Automatic Deployment

When a PR is marked as "ready for review":

1. **Build**: The backend application is built into a Docker image
2. **Push**: The image is pushed to GitHub Container Registry (GHCR)
3. **Deploy**: A unique preview environment is created
4. **Notify**: A comment is posted on the PR with the preview URL and access instructions

### Automatic Teardown

When a PR is merged or closed:

1. The preview environment is marked as inactive
2. Associated resources are cleaned up
3. A teardown comment is posted on the PR

## Architecture

### Components

- **Backend Service**: NestJS application running in a Docker container
- **Database**: PostgreSQL (disposable, ephemeral for each preview)
- **Container Registry**: GitHub Container Registry (GHCR)
- **Orchestration**: Docker Compose for local testing, GitHub Actions for CI/CD

### Environment Isolation

Each preview environment is completely isolated with:

- Unique subdomain or port
- Separate database instance
- Independent environment variables
- Transient GitHub deployment

## Using Preview Environments

### As a PR Author

1. Open a Pull Request
2. Mark it as "ready for review" (remove draft status)
3. Wait for the automated workflow to complete (~2-5 minutes)
4. Find the preview URL in the PR comment
5. Test your changes using the preview URL

### As a Reviewer

1. Navigate to the PR you're reviewing
2. Find the preview environment comment (posted by github-actions bot)
3. Click the preview URL to access the deployed application
4. Test the functionality described in the PR
5. Access API documentation at `{preview-url}/api/docs`
6. Check health status at `{preview-url}/v1/health`

### Testing the Preview

The preview comment includes quick testing commands:

```bash
# Health check
curl https://pr-123.preview.agent.example.com/v1/health

# View API documentation in browser
open https://pr-123.preview.agent.example.com/api/docs

# Test an authenticated endpoint (example)
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://pr-123.preview.agent.example.com/v1/tenants
```

## Local Testing with Docker

You can test the Docker setup locally before pushing:

### Prerequisites

- Docker Desktop or Docker Engine
- Docker Compose

### Steps

1. **Build the image:**
   ```bash
   docker build -f backend/Dockerfile -t agent-backend:local .
   ```

2. **Run with Docker Compose:**
   ```bash
   docker-compose up
   ```

3. **Access the application:**
   - Backend API: http://localhost:3000
   - API Docs: http://localhost:3000/api/docs
   - Health Check: http://localhost:3000/v1/health

4. **Stop and clean up:**
   ```bash
   docker-compose down -v
   ```

### Environment Variables

Create a `.env` file in the root directory for local testing:

```env
NODE_ENV=production
PORT=3000
POSTGRES_DB=agent_db
POSTGRES_USER=agent
POSTGRES_PASSWORD=agent_dev_password
POSTGRES_PORT=5432
DATABASE_URL=postgresql://agent:agent_dev_password@postgres:5432/agent_db
JWT_SECRET=local-test-jwt-secret-min-32-characters
JWT_EXPIRES_IN=1h
CORS_ORIGINS=http://localhost:3001
```

## Deployment Options

The current workflow builds and pushes Docker images to GHCR and deploys to Render in manual PR preview mode.

### Current Configuration: Render (Manual PR Preview Mode)

The workflow is configured to deploy to Render using manual PR preview mode:

```yaml
- name: Deploy to Render
  id: render_deploy
  uses: johnbeynon/render-deploy-action@v0.0.8
  with:
    service-id: ${{ secrets.RENDER_SERVICE_ID }}
    api-key: ${{ secrets.RENDER_API_KEY }}
    wait-for-success: true
```

**Current Service URL:** `https://agent-wmia.onrender.com`

**Secrets configured:**
- `RENDER_API_KEY`: Render API key (configured in repository secrets)
- `RENDER_SERVICE_ID`: Render service ID (configured in repository secrets)

**How it works:**
- Each PR deployment triggers a new deploy to the same Render service
- The service deploys the latest branch commit
- Multiple PRs share the same preview environment (last deployed PR wins)
- Manual mode requires triggering deploys via GitHub Actions rather than automatic Render PR detection

### Alternative Option 1: Fly.io (For isolated PR environments)

Add Fly.io deployment step:

```yaml
- name: Deploy to Fly.io
  uses: superfly/flyctl-actions/setup-flyctl@master
- run: |
    flyctl deploy --remote-only \
      --image ${{ steps.meta.outputs.tags }} \
      --app agent-pr-${{ github.event.pull_request.number }}
  env:
    FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

**Secrets needed:**
- `FLY_API_TOKEN`: Your Fly.io API token

### Alternative Option 2: Railway

Railway has excellent PR preview support:

```yaml
- name: Deploy to Railway
  uses: bervProject/railway-deploy@main
  with:
    railway_token: ${{ secrets.RAILWAY_TOKEN }}
    service: backend
```

**Secrets needed:**
- `RAILWAY_TOKEN`: Your Railway API token

## Configuration

### Required Secrets

The workflow requires these secrets to be configured in your repository:

| Secret | Required | Purpose |
|--------|----------|---------|
| `GITHUB_TOKEN` | Yes (automatic) | Push to GHCR, create deployments |
| `RENDER_API_KEY` | Yes | Deploy to Render |
| `RENDER_SERVICE_ID` | Yes | Identify Render service for deployment |

### Optional Secrets (for alternative deployment providers)

If switching to a different deployment provider, configure its secrets:

| Secret | Provider | Purpose |
|--------|----------|---------|
| `FLY_API_TOKEN` | Fly.io | Deploy to Fly.io |
| `RAILWAY_TOKEN` | Railway | Deploy to Railway |

### Workflow Configuration

The workflow is located at `.github/workflows/pr-preview.yml` and can be customized:

- **Triggers**: Currently triggers on PR ready_for_review, opened, synchronize, reopened
- **Base branch**: Deploys PRs targeting any branch
- **Build context**: Builds from repository root with backend/Dockerfile
- **Registry**: Uses GitHub Container Registry (ghcr.io)

## Troubleshooting

### Build Fails

Check the GitHub Actions logs:
1. Go to the PR's "Checks" tab
2. Click on "PR Preview Environment"
3. Review the build logs

Common issues:
- Missing dependencies in `backend/package.json`
- TypeScript compilation errors
- Missing environment variables

### Preview URL Not Working

- Verify the deployment provider is configured
- Check that all required secrets are set
- Ensure the deployment step completed successfully
- Review the deployment logs in GitHub Actions

### Database Connection Issues

- Verify `DATABASE_URL` is correctly formatted
- Check PostgreSQL service health in Docker Compose
- Ensure the backend waits for database readiness

### Workflow Not Triggering

- Ensure the PR is marked as "ready for review" (not draft)
- Check that the workflow file has no syntax errors
- Verify repository permissions allow workflow execution

## Cost Considerations

### Resource Usage

Each preview environment consumes:
- ~512MB RAM (backend container)
- ~256MB RAM (PostgreSQL container)
- ~500MB disk space (images + data)
- Compute time for build and deployment

### Cost Optimization Strategies

1. **Shared Database**: Use a single PostgreSQL instance with schema isolation
2. **Auto-Shutdown**: Configure provider to shut down after inactivity
3. **Limited Lifetime**: Set max TTL for preview environments (e.g., 7 days)
4. **Concurrent Limit**: Limit number of active preview environments
5. **On-Demand**: Only deploy when explicitly requested (not on every push)

## Security Considerations

### Environment Isolation

- Each preview uses separate environment variables
- Database credentials are unique per preview
- No production data is accessible from previews

### Secrets Management

- Use GitHub Secrets for sensitive values
- Never commit secrets to the repository
- Rotate secrets regularly
- Use minimal permissions for deployment tokens

### Access Control

- Preview URLs should be treated as publicly accessible
- Implement authentication even in preview environments
- Consider IP whitelisting for sensitive previews
- Review PR changes before marking as "ready for review"

## Future Enhancements

Potential improvements to the preview environment system:

- [ ] Add support for frontend preview environments
- [ ] Implement database seeding with test data
- [ ] Add smoke tests that run against preview environments
- [ ] Implement preview environment expiration (auto-cleanup after N days)
- [ ] Add support for custom preview domains
- [ ] Implement preview environment cloning for hotfixes
- [ ] Add Slack/Discord notifications for preview deployments
- [ ] Implement resource usage monitoring and alerting
- [ ] Add support for running migrations on preview databases
- [ ] Implement preview environment snapshots for debugging

## Support

For issues or questions about preview environments:

1. Check the [Troubleshooting](#troubleshooting) section
2. Review GitHub Actions logs for error details
3. Open an issue with the `infrastructure` label
4. Contact the platform team for deployment provider issues

## References

- [Docker Documentation](https://docs.docker.com/)
- [Docker Compose Documentation](https://docs.docker.com/compose/)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [Fly.io Deployment](https://fly.io/docs/app-guides/continuous-deployment-with-github-actions/)
- [Render PR Previews](https://render.com/docs/pull-request-previews)
- [Railway Deployments](https://docs.railway.app/deploy/deployments)
