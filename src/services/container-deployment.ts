import { execSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtemp, rm } from 'fs/promises'
import chalk from 'chalk'
import { z } from 'zod'

// Container deployment specific configuration
export const ContainerDeploymentConfigSchema = z.object({
  registry: z.object({
    endpoint: z.string().describe('Container registry endpoint (e.g. docker-registry.container-registry.svc.cluster.local:5000)'),
    repository: z.string().describe('Repository name (e.g. email-service)'),
    tag: z.string().default('latest').describe('Container image tag'),
    insecure: z.boolean().default(false).describe('Use insecure registry (for in-cluster registries)')
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
    useExistingManifests: z.boolean().default(true).describe('Use existing K8s manifests instead of generating')
  })
})

export type ContainerDeploymentConfig = z.infer<typeof ContainerDeploymentConfigSchema>

export interface ContainerDeploymentResult {
  imageName: string
  imageTag: string
  manifestsApplied: boolean
  podCount: number
  namespace: string
}

export class ContainerDeploymentService {
  async deploy(
    service: any,
    config: any,
    gitHash: string,
    dryRun: boolean = false
  ): Promise<ContainerDeploymentResult> {
    console.log(chalk.blue(`🐳 Starting container deployment for ${service.name}`))
    
    const { registry, kubernetes } = config
    const imageTag = `${gitHash}-${Date.now()}`
    const fullImageName = `${registry.endpoint}/${registry.repository}:${imageTag}`
    const latestImageName = `${registry.endpoint}/${registry.repository}:latest`
    
    if (dryRun) {
      console.log(chalk.yellow('[DRY RUN] Would deploy container:'))
      console.log(`  Image: ${fullImageName}`)
      console.log(`  Registry: ${registry.endpoint}`)
      console.log(`  Namespace: ${kubernetes.namespace}`)
      console.log(`  Replicas: ${kubernetes.replicas}`)
      return {
        imageName: fullImageName,
        imageTag: imageTag,
        manifestsApplied: false,
        podCount: 0,
        namespace: kubernetes.namespace
      }
    }
    
    try {
      // 1. Build container image
      console.log(chalk.gray('Building container image...'))
      // This service needs to receive deployment config too
      const dockerfile = 'Dockerfile' // This is a limitation - we'd need to pass deploymentConfig here
      
      execSync(`docker build -f ${dockerfile} -t ${service.name}:${imageTag} .`, {
        stdio: 'inherit'
      })
      
      // 2. Tag for registry
      console.log(chalk.gray(`Tagging image for registry: ${fullImageName}`))
      execSync(`docker tag ${service.name}:${imageTag} ${fullImageName}`, {
        stdio: 'inherit'
      })
      
      // Also tag as latest
      execSync(`docker tag ${service.name}:${imageTag} ${latestImageName}`, {
        stdio: 'inherit'
      })
      
      // 3. Push to registry
      console.log(chalk.gray('Pushing image to registry...'))
      
      // For in-cluster registries, we might need to use port-forward or NodePort
      if (registry.endpoint.includes('svc.cluster.local')) {
        console.log(chalk.yellow('Detected in-cluster registry, using NodePort for push...'))
        
        // Get the NodePort
        const registryNamespace = config.registry?.namespace || 'container-registry'
        const nodePortOutput = execSync(
          `kubectl get svc -n ${registryNamespace} docker-registry-nodeport -o jsonpath='{.spec.ports[0].nodePort}'`,
          { encoding: 'utf-8' }
        ).trim()
        
        const nodePort = parseInt(nodePortOutput) || config.registry?.nodePort || 30500
        const nodePortRegistry = `localhost:${nodePort}`
        const nodePortImageName = `${nodePortRegistry}/${registry.repository}:${imageTag}`
        const nodePortLatestName = `${nodePortRegistry}/${registry.repository}:latest`
        
        // Tag for NodePort registry
        execSync(`docker tag ${service.name}:${imageTag} ${nodePortImageName}`, {
          stdio: 'inherit'
        })
        execSync(`docker tag ${service.name}:${imageTag} ${nodePortLatestName}`, {
          stdio: 'inherit'
        })
        
        // Push through NodePort
        execSync(`docker push ${nodePortImageName}`, {
          stdio: 'inherit'
        })
        execSync(`docker push ${nodePortLatestName}`, {
          stdio: 'inherit'
        })
        
        console.log(chalk.green('✓ Image pushed to in-cluster registry'))
      } else {
        // External registry
        execSync(`docker push ${fullImageName}`, {
          stdio: 'inherit'
        })
        execSync(`docker push ${latestImageName}`, {
          stdio: 'inherit'
        })
      }
      
      // 4. Apply Kubernetes manifests
      if (kubernetes.useExistingManifests) {
        // Look for existing manifests in standard locations
        const possiblePaths = [
          `${process.cwd()}/k8s/clusters/main/infrastructure/${kubernetes.namespace}/services/${service.name}`,
          `/k8s/clusters/main/infrastructure/${kubernetes.namespace}/services/${service.name}`,
          `k8s/${service.name}`,
          `kubernetes/${service.name}`,
          `.`
        ]
        
        let manifestPath: string | null = null
        for (const path of possiblePaths) {
          const fullPath = path.startsWith('/') ? path : join(process.cwd(), path)
          if (existsSync(fullPath)) {
            const files = execSync(`ls ${fullPath}/*.yaml 2>/dev/null || true`, { encoding: 'utf-8' }).trim()
            if (files) {
              manifestPath = fullPath
              break
            }
          }
        }
        
        if (manifestPath) {
          console.log(chalk.gray(`Applying manifests from ${manifestPath}...`))
          
          // Update image in manifests using kubectl set image
          const deploymentName = `${service.name}`
          const containerName = service.name
          
          // First apply the manifests
          execSync(`kubectl apply -k ${manifestPath}`, {
            stdio: 'inherit'
          })
          
          // Then update the image
          console.log(chalk.gray('Updating deployment image...'))
          execSync(
            `kubectl set image deployment/${deploymentName} ${containerName}=${latestImageName} -n ${kubernetes.namespace}`,
            { stdio: 'inherit' }
          )
          
          // Force a rollout to ensure new image is pulled
          execSync(
            `kubectl rollout restart deployment/${deploymentName} -n ${kubernetes.namespace}`,
            { stdio: 'inherit' }
          )
          
          console.log(chalk.green('✓ Kubernetes manifests applied and image updated'))
        } else {
          console.log(chalk.yellow('No existing manifests found, generating basic deployment...'))
          await this.generateAndApplyManifests(service, config, latestImageName)
        }
      } else {
        await this.generateAndApplyManifests(service, config, latestImageName)
      }
      
      // 5. Wait for rollout
      console.log(chalk.gray('Waiting for deployment to be ready...'))
      try {
        execSync(
          `kubectl rollout status deployment/${service.name} -n ${kubernetes.namespace} --timeout=${kubernetes.deploymentTimeout || 300}s`,
          { stdio: 'inherit' }
        )
      } catch (error) {
        console.log(chalk.yellow('Rollout status check failed, deployment might still be in progress'))
      }
      
      // 6. Check pod status
      const podCountOutput = execSync(
        `kubectl get pods -n ${kubernetes.namespace} -l app=${service.name} --no-headers 2>/dev/null | wc -l`,
        { encoding: 'utf-8' }
      ).trim()
      
      const podCount = parseInt(podCountOutput) || 0
      
      console.log(chalk.green(`✓ Container deployment complete. ${podCount} pods running.`))
      
      // Clean up local images
      console.log(chalk.gray('Cleaning up local images...'))
      try {
        execSync(`docker rmi ${service.name}:${imageTag}`, { stdio: 'pipe' })
      } catch (error) {
        // Ignore cleanup errors
      }
      
      return {
        imageName: latestImageName,
        imageTag: imageTag,
        manifestsApplied: true,
        podCount: podCount,
        namespace: kubernetes.namespace
      }
      
    } catch (error: any) {
      throw new Error(`Container deployment failed: ${error.message}`)
    }
  }
  
  private async generateAndApplyManifests(
    service: any,
    config: any,
    imageName: string
  ): Promise<void> {
    const { kubernetes } = config
    const tempDir = await mkdtemp(join(tmpdir(), 'heimdizzy-'))
    
    try {
      // Generate basic deployment manifest
      const deploymentManifest = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: service.name,
          namespace: kubernetes.namespace
        },
        spec: {
          replicas: kubernetes.replicas,
          selector: {
            matchLabels: {
              app: service.name
            }
          },
          template: {
            metadata: {
              labels: {
                app: service.name
              }
            },
            spec: {
              containers: [{
                name: service.name,
                image: imageName,
                ports: kubernetes.ports,
                env: kubernetes.env || [],
                resources: kubernetes.resources
              }]
            }
          }
        }
      }
      
      // Generate service manifest
      const serviceManifest = {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: service.name,
          namespace: kubernetes.namespace
        },
        spec: {
          selector: {
            app: service.name
          },
          ports: kubernetes.ports.map((p: any) => ({
            name: p.name,
            port: p.containerPort,
            targetPort: p.containerPort
          }))
        }
      }
      
      // Write manifests
      const deploymentPath = join(tempDir, 'deployment.yaml')
      const servicePath = join(tempDir, 'service.yaml')
      
      writeFileSync(deploymentPath, JSON.stringify(deploymentManifest, null, 2))
      writeFileSync(servicePath, JSON.stringify(serviceManifest, null, 2))
      
      // Apply manifests
      execSync(`kubectl apply -f ${deploymentPath}`, { stdio: 'inherit' })
      execSync(`kubectl apply -f ${servicePath}`, { stdio: 'inherit' })
      
    } finally {
      // Cleanup temp directory
      await rm(tempDir, { recursive: true, force: true })
    }
  }
}