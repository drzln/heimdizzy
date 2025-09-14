# Heimdizzy

A powerful deployment tool for container-based services with built-in support for Kubernetes, GitOps, and advanced Rust tooling.

## Features

- 🚀 **Multi-environment deployments** - Development, staging, and production
- 🐳 **Container-native** - First-class Docker and Kubernetes support
- 🔄 **GitOps integration** - Automatic manifest generation and updates
- 📦 **S3 artifact storage** - Centralized artifact management
- 🔧 **Flexible hooks** - Pre/post build and deployment hooks
- 🔔 **Discord notifications** - Real-time deployment status updates
- 🐘 **SQLx support** - Automatic offline mode preparation for Rust services
- 🎯 **Service types** - Lambda, container, web, and hybrid deployments

## Installation

```bash
npm install heimdizzy
```

## Quick Start

1. Create a `heimdizzy.yml` configuration file:

```yaml
version: "1.0"

service:
  name: my-service
  type: container

build:
  dockerfile: Dockerfile
  platform: x86_64
  binaryName: my-service

deployments:
  - name: my-service-staging
    environment: staging
    storage:
      bucket: artifacts
      endpoint: http://minio.local
    deployment:
      type: container
      container:
        registry:
          endpoint: docker-registry.local:5000
          repository: my-service
```

2. Deploy your service:

```bash
heimdizzy deploy staging
```

## Configuration

### Service Types

- **container**: Standard containerized services (default)
- **lambda**: AWS Lambda functions
- **web**: Static web applications
- **hybrid**: Mixed deployment types
- **npm**: NPM package publishing
- **dockerhub**: Docker Hub image publishing

### Build Configuration

```yaml
build:
  dockerfile: Dockerfile
  platform: x86_64  # or arm64
  binaryName: service-name
  features: ["postgres", "redis"]  # Rust features
  sqlx:
    enabled: true  # Enable SQLx offline mode support
```

### Hooks

Execute custom commands at various stages:

```yaml
hooks:
  pre_build:
    - name: prepare-deps
      description: "Copy dependencies"
      command: "cp -r ../libs .deps/"
  post_build:
    - name: cleanup
      command: "rm -rf .deps"
```

## Advanced Features

### SQLx Support

Heimdizzy provides built-in support for SQLx offline mode, allowing you to use compile-time checked SQL queries in Rust services without database access during builds.

```yaml
build:
  sqlx:
    enabled: true
    database:
      migrationsPath: migrations
      port: 15432
    prepare:
      autoGenerate: true
      cacheDirectory: .sqlx
```

See [SQLx Support Documentation](docs/SQLX_SUPPORT.md) for detailed configuration.

### GitOps Integration

Heimdizzy automatically generates and updates Kubernetes manifests:

```yaml
deployment:
  container:
    kubernetes:
      gitOpsPath: k8s/clusters/staging/services/my-service
      useExistingManifests: true
```

### Multi-Product Support

Deploy the same service for different products:

```bash
heimdizzy deploy staging --product product-a
heimdizzy deploy staging --product product-b
```

### NPM Publishing

Publish packages to NPM registries:

```yaml
deployment:
  type: npm
  npm:
    registry: https://registry.npmjs.org/
    access: public  # or 'restricted'
    tag: latest
    # token: provided via NPM_TOKEN env var
```

### Docker Hub Publishing

Publish multi-platform images to Docker Hub:

```yaml
deployment:
  type: dockerhub
  dockerhub:
    repository: username/imagename
    tags:
      - latest
      - v1.0.0
    platform:
      - linux/amd64
      - linux/arm64
    dockerfile: Dockerfile
    buildArgs:
      NODE_VERSION: "18"
    # credentials via DOCKER_USERNAME and DOCKER_PASSWORD env vars
```

## Commands

### deploy

Deploy a service to an environment:

```bash
heimdizzy deploy <environment> [options]

Options:
  --product <name>    Product to deploy for (default: from config)
  --dry-run          Simulate deployment without making changes
  --skip-build       Skip build step and use existing artifacts
```

### build

Build a service without deploying:

```bash
heimdizzy build [options]

Options:
  --dry-run          Show what would be built
```

## Environment Variables

- `HEIMDIZZY_DEBUG`: Enable debug logging
- `HEIMDIZZY_NO_COLOR`: Disable colored output
- `HEIMDIZZY_WEBHOOK`: Override webhook URL

## Examples

### Rust Service with PostgreSQL

```yaml
version: "1.0"

service:
  name: payment-service
  type: container

build:
  dockerfile: Dockerfile
  platform: x86_64
  sqlx:
    enabled: true
    database:
      migrationsPath: migrations

deployments:
  - name: payment-staging
    environment: staging
    hooks:
      pre_build:
        - name: copy-libs
          command: "rsync -av ../../libs/ .deps/"
    deployment:
      type: container
      container:
        kubernetes:
          resources:
            limits:
              memory: "2Gi"
              cpu: "1000m"
```

### Static Web Application

```yaml
version: "1.0"

service:
  name: frontend
  type: web

deployments:
  - name: frontend-production
    environment: production
    deployment:
      type: web
      web:
        buildCommand: "npm run build"
        buildDir: dist
        cloudfront:
          distributionId: ABCDEF123456
```

## Security Best Practices

### Configuration

1. **Never commit secrets**: Use environment variables for all sensitive values
2. **Use .env files**: Copy `.env.example` to `.env` and populate with your values
3. **Secure webhooks**: Store Discord webhook URLs in environment variables
4. **Credentials management**: Use proper credential stores for production

### Environment Variables

Required environment variables (see `.env.example`):

```bash
# MinIO/S3 Configuration
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=your-access-key
MINIO_SECRET_KEY=your-secret-key

# Discord Notifications
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK

# PostgreSQL (for SQLx)
POSTGRES_PASSWORD=your-postgres-password
```

### Production Deployment

1. **Rotate credentials regularly**
2. **Use IAM roles** when deploying to cloud providers
3. **Restrict network access** to registries and storage
4. **Enable audit logging** for all deployments
5. **Use separate credentials** for each environment

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT