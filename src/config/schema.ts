import { z } from 'zod'

export const S3ConfigSchema = z.object({
  endpoint: z.string().optional(),
  region: z.string().default('us-east-1'),
  bucket: z.string(),
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  forcePathStyle: z.boolean().default(true)
})

export const SqlxConfigSchema = z.object({
  enabled: z.boolean().default(false).describe('Enable SQLx offline mode support'),
  database: z.object({
    url: z.string().optional().describe('Database URL for migrations (defaults to postgresql://service:password@localhost:15432/service)'),
    migrationsPath: z.string().default('migrations').describe('Path to migrations directory'),
    port: z.number().default(15432).describe('Local PostgreSQL port for SQLx preparation')
  }).default({}),
  prepare: z.object({
    autoGenerate: z.boolean().default(true).describe('Automatically generate .sqlx directory'),
    cacheDirectory: z.string().default('.sqlx').describe('SQLx cache directory path'),
    dockerImage: z.string().default('postgres:15-alpine').describe('PostgreSQL Docker image for preparation')
  }).default({})
})

export const BuildConfigSchema = z.object({
  dockerfile: z.string().describe('Path to Dockerfile relative to service root'),
  target: z.string().optional().describe('Docker build target stage'),
  platform: z.enum(['x86_64', 'arm64']).default('x86_64'),
  binaryName: z.string().default('lambda'),
  features: z.array(z.string()).optional(),
  useDocker: z.boolean().default(true).describe('Build using Docker container'),
  cleanupContainer: z.boolean().default(true).describe('Remove Docker image after build'),
  sqlx: SqlxConfigSchema.optional().describe('SQLx configuration for compile-time query validation')
})

export const WebDeploymentConfigSchema = z.object({
  buildCommand: z.string().optional().describe('Command to build the web assets (e.g. npm run build, bun run build:optimize)'),
  buildDir: z.string().default('dist').describe('Directory containing built assets'),
  indexFile: z.string().default('index.html').describe('Main HTML file'),
  path: z.string().optional().describe('S3 path prefix for deployment (e.g. novaskyn/frontend/staging)'),
  cloudfront: z.object({
    distributionId: z.string().optional().describe('CloudFront distribution ID for cache invalidation'),
    paths: z.array(z.string()).default(['/*', '/index.html']).describe('Paths to invalidate')
  }).optional(),
  cacheControl: z.object({
    html: z.string().default('no-cache, no-store, must-revalidate').describe('Cache control for HTML files'),
    assets: z.string().default('public, max-age=31536000').describe('Cache control for static assets')
  }).default({}),
  verification: z.object({
    enabled: z.boolean().default(true).describe('Enable deployment verification'),
    endpoints: z.array(z.object({
      path: z.string().describe('Path to verify'),
      expectedStatus: z.number().describe('Expected HTTP status code'),
      contains: z.string().optional().describe('Text that should be present in response')
    })).optional().describe('HTTP endpoints to verify after deployment'),
    minioCheck: z.object({
      enabled: z.boolean().default(true).describe('Verify files in MinIO/S3'),
      minFiles: z.number().default(5).describe('Minimum expected file count')
    }).optional().describe('MinIO/S3 verification settings')
  }).optional().describe('Post-deployment verification configuration')
})

export const ContainerDeploymentConfigSchema = z.object({
  registry: z.object({
    endpoint: z.string().describe('Container registry endpoint'),
    repository: z.string().describe('Repository name'),
    tag: z.string().default('latest').describe('Container image tag'),
    insecure: z.boolean().default(false).describe('Use insecure registry'),
    nodePort: z.number().optional().describe('NodePort for in-cluster registry push (defaults to auto-discovery)'),
    namespace: z.string().default('container-registry').describe('Namespace where container registry is deployed')
  }),
  kubernetes: z.object({
    namespace: z.string().describe('Kubernetes namespace (required - no default)'),
    replicas: z.number().default(2).describe('Number of replicas'),
    resources: z.object({
      requests: z.object({
        memory: z.string().default('256Mi'),
        cpu: z.string().default('100m')
      }),
      limits: z.object({
        memory: z.string().default('512Mi'),
        cpu: z.string().default('300m')
      })
    }).default({
      requests: { memory: '256Mi', cpu: '100m' },
      limits: { memory: '512Mi', cpu: '300m' }
    }),
    ports: z.array(z.object({
      containerPort: z.number(),
      name: z.string()
    })).default([{ containerPort: 8080, name: 'http' }]),
    env: z.array(z.object({
      name: z.string(),
      value: z.string()
    })).optional(),
    useExistingManifests: z.boolean().default(true).describe('Use existing K8s manifests'),
    gitOpsPath: z.string().optional().describe('Custom GitOps kustomization path (relative to repo root)'),
    deploymentTimeout: z.number().default(300).describe('Deployment rollout timeout in seconds'),
    fluxNamespace: z.string().default('flux-system').describe('FluxCD namespace for GitOps operations')
  }),
  gitops: z.boolean().default(true).describe('Use GitOps deployment pattern (recommended)')
})

export const NpmDeploymentConfigSchema = z.object({
  registry: z.string().default('https://registry.npmjs.org/').describe('NPM registry URL'),
  access: z.enum(['public', 'restricted']).default('public').describe('Package access level'),
  tag: z.string().default('latest').describe('NPM publish tag'),
  dryRun: z.boolean().default(false).describe('Perform dry run without publishing'),
  otp: z.string().optional().describe('One-time password for 2FA'),
  token: z.string().optional().describe('NPM auth token (defaults to NPM_TOKEN env var)')
})

export const DockerHubDeploymentConfigSchema = z.object({
  repository: z.string().describe('Docker Hub repository (e.g., username/imagename)'),
  tag: z.string().default('latest').describe('Docker image tag'),
  tags: z.array(z.string()).optional().describe('Additional tags to apply'),
  username: z.string().optional().describe('Docker Hub username (defaults to DOCKER_USERNAME env var)'),
  password: z.string().optional().describe('Docker Hub password (defaults to DOCKER_PASSWORD env var)'),
  dockerfile: z.string().default('Dockerfile').describe('Path to Dockerfile'),
  buildArgs: z.record(z.string()).optional().describe('Docker build arguments'),
  platform: z.array(z.string()).default(['linux/amd64']).describe('Target platforms for multi-platform builds')
})

export const DeploymentSchema = z.object({
  type: z.enum(['lambda-zip', 'container', 'web', 'npm', 'dockerhub']).default('lambda-zip'),
  runtime: z.enum(['rust', 'nodejs', 'python', 'go']).default('rust'),
  artifact: z.object({
    key: z.string().optional(),
    metadata: z.record(z.string()).optional()
  }).optional(),
  web: WebDeploymentConfigSchema.optional().describe('Web-specific deployment configuration'),
  container: ContainerDeploymentConfigSchema.optional().describe('Container-specific deployment configuration'),
  npm: NpmDeploymentConfigSchema.optional().describe('NPM-specific deployment configuration'),
  dockerhub: DockerHubDeploymentConfigSchema.optional().describe('Docker Hub-specific deployment configuration')
})

export const HookSchema = z.object({
  name: z.string().describe('Hook name'),
  description: z.string().optional().describe('Hook description'),
  command: z.string().describe('Shell command to execute')
})

export const HooksSchema = z.object({
  pre_build: z.array(HookSchema).optional().describe('Hooks to run before building'),
  post_build: z.array(HookSchema).optional().describe('Hooks to run after building'),
  pre_deploy: z.array(HookSchema).optional().describe('Hooks to run before deployment'),
  post_deploy: z.array(HookSchema).optional().describe('Hooks to run after deployment')
})

export const NotificationSchema = z.object({
  webhook: z.string().url().optional(),
  enabled: z.boolean().default(true),
  rateLimitDelay: z.number().default(2000).describe('Delay in ms when rate limited'),
  events: z.object({
    deployStart: z.boolean().default(true),
    deploySuccess: z.boolean().default(true),
    deployError: z.boolean().default(true),
    buildStart: z.boolean().default(true),
    buildSuccess: z.boolean().default(true),
    buildSkipped: z.boolean().default(true),
    uploadStart: z.boolean().default(true),
    uploadSuccess: z.boolean().default(true),
    uploadSkipped: z.boolean().default(true),
    podsRestarting: z.boolean().default(true),
    podsReady: z.boolean().default(true),
    webDeploying: z.boolean().default(true),
    webDeployed: z.boolean().default(true),
    cleanup: z.boolean().default(true),
    dryRun: z.boolean().default(true)
  }).default({})
})

export const GlobalConfigSchema = z.object({
  projectRoot: z.string().optional().describe('Project root directory (defaults to auto-detection from git)'),
  kubectlPath: z.string().optional().describe('Path to kubectl binary (defaults to kubectl in PATH)'),
  gitOpsBasePath: z.string().optional().describe('Base path for GitOps manifests (e.g., nix/k8s/clusters/plo)'),
  clusterName: z.string().optional().describe('Kubernetes cluster name (e.g., plo)')
}).optional()

export const HeimdizzyConfigSchema = z.object({
  version: z.literal('1.0'),
  service: z.object({
    name: z.string(),
    type: z.enum(['lambda', 'container', 'hybrid', 'web', 'npm', 'dockerhub']).default('lambda'),
    product: z.string().optional().describe('Product this service is deployed for'),
    category: z.string().optional().describe('Service category (e.g., infrastructure, core, auth)')
  }),
  global: GlobalConfigSchema.describe('Global configuration options'),
  build: BuildConfigSchema.optional(),
  deployments: z.array(z.object({
    name: z.string(),
    environment: z.enum(['development', 'staging', 'production']),
    build: BuildConfigSchema.optional().describe('Override build configuration for this deployment'),
    hooks: HooksSchema.optional().describe('Deployment hooks'),
    storage: S3ConfigSchema,
    deployment: DeploymentSchema,
    notifications: NotificationSchema.optional()
  }))
})

export type HeimdizzyConfig = z.infer<typeof HeimdizzyConfigSchema>
export type S3Config = z.infer<typeof S3ConfigSchema>
export type SqlxConfig = z.infer<typeof SqlxConfigSchema>
export type BuildConfig = z.infer<typeof BuildConfigSchema>
export type DeploymentConfig = z.infer<typeof DeploymentSchema>
export type WebDeploymentConfig = z.infer<typeof WebDeploymentConfigSchema>
export type NpmDeploymentConfig = z.infer<typeof NpmDeploymentConfigSchema>
export type DockerHubDeploymentConfig = z.infer<typeof DockerHubDeploymentConfigSchema>
export type Hook = z.infer<typeof HookSchema>
export type Hooks = z.infer<typeof HooksSchema>