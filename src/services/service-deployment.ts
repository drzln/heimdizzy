import { execSync } from 'child_process'
import chalk from 'chalk'
import * as fs from 'fs'
import * as path from 'path'
import { ServiceDeploymentConfig } from '../config/schema.js'
import { RustBuildService } from './rust-build.js'

export interface ServiceDeploymentResult {
  imageName: string
  imageTag: string
  migrationCompleted: boolean
  deploymentRestarted: boolean
  healthCheckPassed: boolean
  podCount: number
  namespace: string
  gitHash?: string
  buildTimestamp?: string
}

export class ServiceDeploymentService {
  private rustBuildService = new RustBuildService()
  
  async deploy(
    service: any,
    deployment: ServiceDeploymentConfig,
    gitHash: string,
    dryRun: boolean = false,
    deploymentConfig?: any,
    fullConfig?: any
  ): Promise<ServiceDeploymentResult> {
    console.log(chalk.blue(`🚀 Service deployment for ${service.name}`))
    
    const timestamp = new Date().toISOString()
    const jobName = `${service.name}-migration-${Date.now()}`
    
    // Extract configuration
    const { container } = deployment
    const { registry, kubernetes } = container
    const namespace = kubernetes.namespace
    
    // Full image names
    const imageTag = gitHash || 'latest'
    const fullImageName = `${registry.endpoint}/${registry.repository}:${imageTag}`
    const latestImageName = `${registry.endpoint}/${registry.repository}:latest`
    
    if (dryRun) {
      console.log(chalk.yellow('[DRY RUN] Would perform service deployment:'))
      console.log(`  1. Build image: ${fullImageName}`)
      console.log(`  2. Push to registry: ${registry.endpoint}`)
      console.log(`  3. Run migration job: ${jobName}`)
      console.log(`  4. Update deployment in namespace: ${namespace}`)
      console.log(`  5. Verify health check`)
      return {
        imageName: fullImageName,
        imageTag: imageTag,
        migrationCompleted: false,
        deploymentRestarted: false,
        healthCheckPassed: false,
        podCount: 0,
        namespace: namespace
      }
    }
    
    try {
      // Step 1: Build Docker image
      console.log(chalk.gray('📦 Building Docker image...'))
      const dockerfile = deploymentConfig?.build?.dockerfile || 'Dockerfile'
      
      const gitSha = gitHash || 'unknown'
      const buildTimestamp = timestamp
      
      await this.rustBuildService.buildDockerImage(
        service.name,
        imageTag,
        dockerfile,
        {
          GIT_SHA: gitSha,
          BUILD_TIMESTAMP: buildTimestamp
        }
      )
      
      // Tag for registry
      console.log(chalk.gray(`🏷️  Tagging image for registry: ${fullImageName}`))
      execSync(`docker tag ${service.name}:${imageTag} ${fullImageName}`, {
        stdio: 'inherit'
      })
      execSync(`docker tag ${service.name}:${imageTag} ${latestImageName}`, {
        stdio: 'inherit'
      })
      
      // Step 2: Push to registry
      console.log(chalk.gray('📤 Pushing image to registry...'))
      
      // Docker login if credentials provided
      if (registry.username && registry.password) {
        console.log(chalk.gray(`🔐 Logging into Docker registry: ${registry.endpoint}`))
        try {
          execSync(`echo "${registry.password}" | docker login ${registry.endpoint} -u ${registry.username} --password-stdin`, {
            stdio: 'inherit'
          })
          console.log(chalk.green('✓ Docker login successful'))
        } catch (error) {
          console.error(chalk.red('Docker login failed'))
          throw error
        }
      }
      
      // Push images
      execSync(`docker push ${fullImageName}`, {
        stdio: 'inherit'
      })
      execSync(`docker push ${latestImageName}`, {
        stdio: 'inherit'
      })
      console.log(chalk.green('✓ Image pushed successfully'))
      
      // Step 3: Run migration job
      console.log(chalk.gray('🔄 Running database migrations...'))
      const migrationResult = await this.runMigrationJob(
        service.name,
        jobName,
        fullImageName,
        namespace,
        gitSha,
        buildTimestamp,
        kubernetes.env || []
      )
      
      if (!migrationResult) {
        throw new Error('Migration job failed')
      }
      console.log(chalk.green('✓ Migrations completed successfully'))
      
      // Step 4: Update Kubernetes deployment
      console.log(chalk.gray('🔄 Updating Kubernetes deployment...'))
      
      // Force a rollout restart to pick up the new image
      execSync(`kubectl rollout restart deployment/${service.name} -n ${namespace}`, {
        stdio: 'inherit'
      })
      
      // Wait for rollout to complete
      console.log(chalk.gray('⏳ Waiting for rollout to complete...'))
      execSync(`kubectl rollout status deployment/${service.name} -n ${namespace} --timeout=300s`, {
        stdio: 'inherit'
      })
      console.log(chalk.green('✓ Deployment rollout completed'))
      
      // Step 5: Verify health check
      console.log(chalk.gray('🏥 Verifying service health...'))
      const healthResult = await this.verifyHealth(service.name, namespace, gitSha, buildTimestamp)
      
      if (!healthResult) {
        throw new Error('Health check verification failed')
      }
      console.log(chalk.green('✓ Service health check passed'))
      
      // Get pod count
      const podCountCmd = `kubectl get pods -n ${namespace} -l app=${service.name} --no-headers 2>/dev/null | wc -l`
      const podCount = parseInt(execSync(podCountCmd, { encoding: 'utf-8' }).trim()) || 0
      
      console.log(chalk.green(`✅ Service deployment successful!`))
      console.log(chalk.gray(`   Image: ${fullImageName}`))
      console.log(chalk.gray(`   Namespace: ${namespace}`))
      console.log(chalk.gray(`   Pods: ${podCount}`))
      
      return {
        imageName: fullImageName,
        imageTag: imageTag,
        migrationCompleted: true,
        deploymentRestarted: true,
        healthCheckPassed: true,
        podCount: podCount,
        namespace: namespace,
        gitHash: gitSha,
        buildTimestamp: buildTimestamp
      }
      
    } catch (error: any) {
      console.error(chalk.red(`❌ Service deployment failed: ${error.message}`))
      
      // Attempt rollback
      console.log(chalk.yellow('🔄 Attempting rollback...'))
      try {
        execSync(`kubectl rollout undo deployment/${service.name} -n ${namespace}`, {
          stdio: 'inherit'
        })
        console.log(chalk.yellow('✓ Rollback completed'))
      } catch (rollbackError) {
        console.error(chalk.red('❌ Rollback failed'))
      }
      
      throw error
    }
  }
  
  private async runMigrationJob(
    serviceName: string,
    jobName: string,
    image: string,
    namespace: string,
    gitHash: string,
    timestamp: string,
    serviceEnv: any[]
  ): Promise<boolean> {
    // Create migration job manifest
    const migrationJob = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobName,
        namespace: namespace,
        labels: {
          app: serviceName,
          component: 'migration',
          service: serviceName
        },
        annotations: {
          'deployment.kubernetes.io/timestamp': timestamp,
          'deployment.kubernetes.io/git-sha': gitHash
        }
      },
      spec: {
        backoffLimit: 3,
        activeDeadlineSeconds: 300,
        ttlSecondsAfterFinished: 3600,
        template: {
          metadata: {
            labels: {
              app: serviceName,
              component: 'migration'
            }
          },
          spec: {
            restartPolicy: 'Never',
            imagePullSecrets: [
              { name: 'ghcr-secret' }
            ],
            containers: [
              {
                name: `${serviceName}-migrator`,
                image: image,
                imagePullPolicy: 'Always',
                env: [
                  { name: 'RUN_MODE', value: 'migrate' },
                  { name: 'RUST_LOG', value: `info,${serviceName}=debug` },
                  { name: 'GIT_SHA', value: gitHash },
                  { name: 'BUILD_TIMESTAMP', value: timestamp },
                  // Include service-specific environment variables
                  ...serviceEnv.filter(e => e.name.includes('DATABASE') || e.name.includes('REDIS'))
                ],
                envFrom: [
                  { configMapRef: { name: `${serviceName}-config` } }
                ],
                resources: {
                  requests: {
                    memory: '128Mi',
                    cpu: '100m'
                  },
                  limits: {
                    memory: '256Mi',
                    cpu: '500m'
                  }
                }
              }
            ]
          }
        }
      }
    }
    
    // Apply the job
    const jobManifestPath = `/tmp/${jobName}.yaml`
    fs.writeFileSync(jobManifestPath, JSON.stringify(migrationJob, null, 2))
    
    try {
      execSync(`kubectl apply -f ${jobManifestPath}`, {
        stdio: 'inherit'
      })
      
      // Wait for job completion
      console.log(chalk.gray('⏳ Waiting for migration to complete...'))
      execSync(`kubectl wait --for=condition=complete job/${jobName} -n ${namespace} --timeout=300s`, {
        stdio: 'inherit'
      })
      
      // Check job status
      const jobStatus = execSync(
        `kubectl get job ${jobName} -n ${namespace} -o jsonpath='{.status.conditions[0].type}'`,
        { encoding: 'utf-8' }
      ).trim()
      
      if (jobStatus !== 'Complete') {
        // Get job logs for debugging
        console.error(chalk.red('Migration job failed. Logs:'))
        execSync(`kubectl logs job/${jobName} -n ${namespace}`, {
          stdio: 'inherit'
        })
        return false
      }
      
      // Cleanup job
      execSync(`kubectl delete job ${jobName} -n ${namespace} --ignore-not-found=true`, {
        stdio: 'inherit'
      })
      
      return true
    } finally {
      // Cleanup manifest file
      if (fs.existsSync(jobManifestPath)) {
        fs.unlinkSync(jobManifestPath)
      }
    }
  }
  
  private async verifyHealth(
    serviceName: string,
    namespace: string,
    expectedGitHash?: string,
    expectedTimestamp?: string
  ): Promise<boolean> {
    const maxRetries = 30
    const retryDelay = 10000 // 10 seconds
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        // Get a running pod
        const podName = execSync(
          `kubectl get pod -l app=${serviceName} -n ${namespace} -o jsonpath='{.items[0].metadata.name}'`,
          { encoding: 'utf-8' }
        ).trim()
        
        if (!podName) {
          console.log(chalk.gray(`  Attempt ${i + 1}/${maxRetries}: No pods found yet...`))
          await new Promise(resolve => setTimeout(resolve, retryDelay))
          continue
        }
        
        // Execute health check
        const healthResponse = execSync(
          `kubectl exec ${podName} -n ${namespace} -- curl -s http://localhost:8081/health || echo "{}"`,
          { encoding: 'utf-8' }
        ).trim()
        
        let healthData
        try {
          healthData = JSON.parse(healthResponse)
        } catch (e) {
          console.log(chalk.gray(`  Attempt ${i + 1}/${maxRetries}: Invalid health response...`))
          await new Promise(resolve => setTimeout(resolve, retryDelay))
          continue
        }
        
        if (healthData.status === 'healthy') {
          console.log(chalk.green(`✓ Health check passed`))
          console.log(chalk.gray(`  Status: ${healthData.status}`))
          console.log(chalk.gray(`  Version: ${healthData.version || 'unknown'}`))
          console.log(chalk.gray(`  Git Hash: ${healthData.git_hash || 'unknown'}`))
          console.log(chalk.gray(`  Build Time: ${healthData.build_timestamp || 'unknown'}`))
          
          // Verify version if provided
          if (expectedGitHash && healthData.git_hash && healthData.git_hash !== expectedGitHash) {
            console.warn(chalk.yellow(`  ⚠️  Git hash mismatch: expected ${expectedGitHash}, got ${healthData.git_hash}`))
          }
          
          // Check dependencies
          if (healthData.dependencies) {
            console.log(chalk.gray(`  Dependencies:`))
            Object.entries(healthData.dependencies).forEach(([dep, status]) => {
              const icon = status === 'healthy' ? '✓' : '✗'
              console.log(chalk.gray(`    ${icon} ${dep}: ${status}`))
            })
          }
          
          return true
        }
        
        console.log(chalk.gray(`  Attempt ${i + 1}/${maxRetries}: Service not healthy yet...`))
        await new Promise(resolve => setTimeout(resolve, retryDelay))
        
      } catch (error) {
        console.log(chalk.gray(`  Attempt ${i + 1}/${maxRetries}: Health check failed...`))
        await new Promise(resolve => setTimeout(resolve, retryDelay))
      }
    }
    
    return false
  }
}