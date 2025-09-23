# Making Any Service Deployable with Heimdizzy

**Note: Heimdizzy is now primarily used through GitHub Actions workflows. For new services, use the GitHub Actions template instead of manual deployment.**

For GitHub Actions deployment, see: [GitHub Actions Setup Guide](../../../.github/README.md)

For legacy manual deployment, you need 2 files:

## 1. `heimdizzy.yml` (Required)

Drop this file in your service root directory:

```yaml
# Heimdizzy deployment configuration
version: "1.0"

service:
  name: your-service-name
  type: lambda
  product: my-product  # Default product, can be overridden via CLI

build:
  dockerfile: Dockerfile.staging.deploy
  target: lambda
  platform: x86_64
  binaryName: lambda
  features: []
  useDocker: true
  cleanupContainer: true

deployments:
  - name: your-service-staging
    environment: staging
    storage:
      endpoint: YOUR_MINIO_ENDPOINT
      region: us-east-1
      bucket: lambda-artifacts
      forcePathStyle: true
      accessKeyId: YOUR_ACCESS_KEY_ID
      secretAccessKey: YOUR_SECRET_ACCESS_KEY
    deployment:
      type: lambda-zip
      runtime: rust
      artifact:
        key: your-service/lambda-latest.zip
    notifications:
      webhook: YOUR_DISCORD_WEBHOOK_URL
      enabled: true

  - name: your-service-production
    environment: production
    storage:
      region: us-east-1
      bucket: nexus-lambda-artifacts
    deployment:
      type: lambda-zip
      runtime: rust
      artifact:
        key: your-service/lambda-latest.zip
```

## 2. Package.json Configuration (Optional)

Add these scripts to your `package.json` for convenience:

```json
{
  "dependencies": {
    "heimdizzy": "^1.0.0"
  },
  "scripts": {
    "deploy:myproduct:staging": "heimdizzy deploy staging --product myproduct",
    "deploy:yourproduct:staging": "heimdizzy deploy staging --product yourproduct"
  }
}
```

## 3. Install Heimdizzy

```bash
npm install heimdizzy
```

## Usage

### Recommended: GitHub Actions (Automated)

1. **Set up GitHub Actions workflow** using the template:
   ```bash
   cp .github/workflows/service-deploy-template.yml \
      .github/workflows/your-service-deploy.yml
   ```

2. **Push code to trigger deployment:**
   ```bash
   git push origin main      # → Production
   git push origin develop   # → Staging
   ```

### Legacy: Manual CLI Deployment

Once set up, you can deploy manually with:

```bash
# Via npm scripts
npm run deploy:myproduct:staging
npm run deploy:yourproduct:staging

# Or directly 
npx heimdizzy deploy staging --product myproduct
```

**Note: Manual deployment is primarily for debugging. Use GitHub Actions for production deployments.**

## Features

✅ **Multi-Product Support**: Deploy the same service for different products
✅ **Discord Notifications**: Get deployment status in Discord
✅ **Docker Build**: Automatic Docker containerization
✅ **S3/MinIO Upload**: Automatic artifact upload
✅ **Kubernetes Integration**: Automatic pod restarts
✅ **Rate Limiting**: Discord webhook rate limiting
✅ **Dry Run Mode**: Test deployments without executing

## Requirements

- `heimdizzy.yml` in service root
- `Dockerfile.staging.deploy` (use the gateway service version for consistency)
- Service must be buildable as Lambda ZIP package

## Important Notes

⚠️ **Rust 1.82 Compatibility**: All services use Rust 1.82-alpine for consistency. If using AWS SDK, use these tested working versions:
- `aws-config = "0.52"`
- `aws-sdk-dynamodb = "0.22"`
- `aws-sdk-s3 = "0.22"`

**Important**: These specific versions work reliably with Rust 1.82. Use the older `model::AttributeValue` import path, not `types::AttributeValue`.

⚠️ **Use the same Dockerfile.staging.deploy as the gateway service** to ensure consistent builds. Copy it from `pkgs/services/gateway/Dockerfile.staging.deploy`.

That's it! No deployment scripts, no complex setup. Just drop `heimdizzy.yml` and you're ready to deploy.