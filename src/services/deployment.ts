import { execSync } from 'child_process'
import chalk from 'chalk'
import { WebDeploymentService } from './web-deployment.js'
import { ContainerDeploymentService, ContainerDeploymentResult } from './container-deployment.js'
import { GitOpsContainerDeploymentService, GitOpsContainerDeploymentResult } from './gitops-container-deployment.js'
import { NpmDeploymentService } from './npm-deployment.js'
import { DockerHubDeploymentService } from './dockerhub-deployment.js'
import { ServiceDeploymentService, ServiceDeploymentResult } from './service-deployment.js'
import { HooksService } from './hooks.js'
import { Hooks } from '../config/schema.js'

export interface DeploymentResult {
  podCount?: number
  podStatus?: string
  skipped?: boolean
  deployedFiles?: number
  invalidationId?: string
  buildTime?: number
  deployTime?: number
  container?: ContainerDeploymentResult
  npm?: {
    packageName: string
    version: string
    registry: string
    tag: string
    published: boolean
  }
  dockerhub?: {
    repository: string
    tag: string
    additionalTags: string[]
    pushed: boolean
    imageName: string
  }
  service?: ServiceDeploymentResult
}

export class DeploymentService {
  private webDeploymentService = new WebDeploymentService()
  private containerDeploymentService = new ContainerDeploymentService()
  private gitOpsContainerDeploymentService = new GitOpsContainerDeploymentService()
  private npmDeploymentService = new NpmDeploymentService()
  private dockerHubDeploymentService = new DockerHubDeploymentService()
  private serviceDeploymentService = new ServiceDeploymentService()
  private hooksService = new HooksService()

  async deploy(
    service: any,
    deploymentConfig: any,
    dryRun: boolean = false,
    gitHash?: string,
    fullConfig?: any
  ): Promise<DeploymentResult> {
    console.log(chalk.gray(`🔍 Deployment config keys: ${Object.keys(deploymentConfig).join(', ')}`))
    const { deployment, storage, hooks } = deploymentConfig
    console.log(chalk.gray(`🔍 Hooks object: ${hooks ? 'defined' : 'undefined'}`))
    if (hooks) {
      console.log(chalk.gray(`🔍 Hooks properties: ${Object.keys(hooks).join(', ')}`))
    }
    
    if (deployment.type === 'web') {
      return this.deployWeb(service, storage, deployment, hooks, dryRun)
    }
    
    if (deployment.type === 'container') {
      return this.deployContainer(service, deployment, gitHash || 'latest', dryRun, deploymentConfig.hooks, deploymentConfig, fullConfig)
    }
    
    if (deployment.type === 'npm') {
      return this.deployNpm(service, deployment, fullConfig?.global?.projectRoot, dryRun, hooks)
    }
    
    if (deployment.type === 'dockerhub') {
      return this.deployDockerHub(service, deployment, fullConfig?.global?.projectRoot, gitHash || 'latest', dryRun, hooks)
    }
    
    if (deployment.type === 'lambda-zip' && deploymentConfig.environment === 'staging') {
      return this.deployToKubernetes(service, dryRun)
    }
    
    console.log(chalk.yellow('Non-Kubernetes deployments not yet implemented'))
    return { skipped: true }
  }

  private async deployContainer(
    service: any,
    deployment: any,
    gitHash: string,
    dryRun: boolean,
    hooks?: Hooks,
    deploymentConfig?: any,
    fullConfig?: any
  ): Promise<DeploymentResult> {
    console.log(chalk.blue(`🐳 Container deployment for ${service.name}`))
    
    if (!deployment.container) {
      throw new Error('Container deployment configuration is required for container deploy type')
    }

    // Execute pre-build hooks BEFORE any Docker operations
    if (hooks?.pre_build) {
      await this.hooksService.executeHooks(hooks.pre_build, 'pre-build')
    }
    
    // Use GitOps approach if enabled (default true)
    const useGitOps = deployment.container.gitops !== false
    
    if (useGitOps) {
      console.log(chalk.green('Using GitOps deployment pattern'))
      const gitOpsResult = await this.gitOpsContainerDeploymentService.deploy(
        service,
        deployment.container,
        gitHash,
        dryRun,
        hooks,
        deploymentConfig,
        fullConfig
      )
      
      return {
        podCount: 0, // FluxCD will handle the actual deployment
        container: {
          imageName: gitOpsResult.imageName,
          imageTag: gitOpsResult.imageTag,
          manifestsApplied: gitOpsResult.manifestUpdated,
          podCount: 0,
          namespace: deployment.container.kubernetes.namespace
        }
      }
    } else {
      // Fallback to direct deployment (not recommended)
      console.log(chalk.yellow('Using direct deployment (not recommended for production)'))
      const containerResult = await this.containerDeploymentService.deploy(
        service,
        deployment.container,
        gitHash,
        dryRun
      )
      
      return {
        podCount: containerResult.podCount,
        container: containerResult
      }
    }
  }

  private async deployNpm(
    service: any,
    deployment: any,
    projectRoot: string | undefined,
    dryRun: boolean,
    hooks?: Hooks
  ): Promise<DeploymentResult> {
    console.log(chalk.blue(`📦 Starting NPM deployment for ${service.name}`))
    
    if (!deployment.npm) {
      throw new Error('NPM deployment configuration is required for npm deploy type')
    }
    
    if (!projectRoot) {
      throw new Error('Project root is required for NPM deployment')
    }
    
    // Execute pre-deployment hooks
    if (hooks?.pre_deploy) {
      await this.hooksService.executeHooks(hooks.pre_deploy, 'pre-deployment')
    }
    
    const npmResult = await this.npmDeploymentService.deploy(
      service,
      deployment.npm,
      projectRoot,
      dryRun
    )
    
    // Execute post-deployment hooks
    if (hooks?.post_deploy) {
      await this.hooksService.executeHooks(hooks.post_deploy, 'post-deployment')
    }
    
    return {
      npm: npmResult
    }
  }

  private async deployDockerHub(
    service: any,
    deployment: any,
    projectRoot: string | undefined,
    gitHash: string,
    dryRun: boolean,
    hooks?: Hooks
  ): Promise<DeploymentResult> {
    console.log(chalk.blue(`🐳 Starting Docker Hub deployment for ${service.name}`))
    
    if (!deployment.dockerhub) {
      throw new Error('Docker Hub deployment configuration is required for dockerhub deploy type')
    }
    
    if (!projectRoot) {
      throw new Error('Project root is required for Docker Hub deployment')
    }
    
    // Execute pre-build hooks
    if (hooks?.pre_build) {
      await this.hooksService.executeHooks(hooks.pre_build, 'pre-build')
    }
    
    // Execute post-build hooks before push
    if (hooks?.post_build) {
      await this.hooksService.executeHooks(hooks.post_build, 'post-build')
    }
    
    // Execute pre-deployment hooks
    if (hooks?.pre_deploy) {
      await this.hooksService.executeHooks(hooks.pre_deploy, 'pre-deployment')
    }
    
    const dockerhubResult = await this.dockerHubDeploymentService.deploy(
      service,
      deployment.dockerhub,
      projectRoot,
      gitHash,
      dryRun
    )
    
    // Execute post-deployment hooks
    if (hooks?.post_deploy) {
      await this.hooksService.executeHooks(hooks.post_deploy, 'post-deployment')
    }
    
    return {
      dockerhub: dockerhubResult
    }
  }

  private async deployWeb(
    service: any,
    storage: any,
    deployment: any,
    hooks: Hooks | undefined,
    dryRun: boolean
  ): Promise<DeploymentResult> {
    console.log(chalk.blue(`🌐 Starting web deployment for ${service.name}`))
    
    // Validate web deployment config
    if (!deployment.web) {
      throw new Error('Web deployment configuration is required for web deploy type')
    }
    
    // Debug: Log hooks configuration
    console.log(chalk.gray(`📋 Hooks configuration:`))
    console.log(chalk.gray(`   - pre_deploy: ${hooks?.pre_deploy ? hooks.pre_deploy.length + ' hooks' : 'none'}`))
    console.log(chalk.gray(`   - post_deploy: ${hooks?.post_deploy ? hooks.post_deploy.length + ' hooks' : 'none'}`))
    
    // Execute pre-deployment hooks
    if (hooks?.pre_deploy) {
      await this.hooksService.executeHooks(hooks.pre_deploy, 'pre-deployment')
    }
    
    const webResult = await this.webDeploymentService.deploy(
      {
        name: service.name,
        product: service.product
      },
      storage,
      deployment.web,
      dryRun
    )
    
    console.log(chalk.gray(`📋 Web deployment completed, preparing to run post-deployment hooks...`))
    
    // Execute post-deployment hooks
    try {
      if (hooks?.post_deploy) {
        console.log(chalk.gray(`📋 Found ${hooks.post_deploy.length} post-deployment hooks to execute`))
        await this.hooksService.executeHooks(hooks.post_deploy, 'post-deployment')
      } else {
        console.log(chalk.gray(`📋 No post-deployment hooks configured`))
      }
    } catch (error: any) {
      console.error(chalk.red(`❌ Error executing post-deployment hooks: ${error.message}`))
      console.error(chalk.red(`Stack trace: ${error.stack}`))
      // Re-throw to maintain existing behavior
      throw error
    }
    
    return {
      deployedFiles: webResult.deployedFiles,
      invalidationId: webResult.invalidationId,
      buildTime: webResult.buildTime,
      deployTime: webResult.deployTime
    }
  }
  
  private async deployToKubernetes(service: any, dryRun: boolean): Promise<DeploymentResult> {
    console.log(chalk.gray(`Deploying ${service.name} to Kubernetes...`))
    
    const namespace = 'novaskyn'
    const selector = `app=${service.name}-lambda-rie`
    
    if (dryRun) {
      console.log(chalk.yellow('[DRY RUN] Would restart pods:'))
      console.log(`  Namespace: ${namespace}`)
      console.log(`  Selector: ${selector}`)
      return { skipped: true }
    }
    
    try {
      // Check if pods exist
      const checkCommand = `kubectl get pods -n ${namespace} -l ${selector} --no-headers 2>/dev/null | wc -l`
      const podCount = execSync(checkCommand, { encoding: 'utf-8' }).trim()
      
      if (podCount === '0') {
        console.log(chalk.yellow(`No pods found with selector ${selector}`))
        return { podCount: 0 }
      }
      
      // Restart pods to pick up new code
      console.log(chalk.gray(`Restarting ${podCount} pod(s)...`))
      execSync(`kubectl delete pods -n ${namespace} -l ${selector}`, { 
        stdio: 'inherit' 
      })
      
      console.log(chalk.green('✓ Pods restarted successfully'))
      
      // Wait a moment and check pod status
      console.log(chalk.gray('Waiting for pods to start...'))
      await new Promise(resolve => setTimeout(resolve, 3000))
      
      const statusCommand = `kubectl get pods -n ${namespace} -l ${selector} --no-headers`
      const status = execSync(statusCommand, { encoding: 'utf-8' })
      console.log(chalk.gray('Pod status:'))
      console.log(status)
      
      return {
        podCount: parseInt(podCount),
        podStatus: status.trim()
      }
      
    } catch (error: any) {
      // Non-fatal error if kubectl is not available
      if (error.message.includes('kubectl: command not found')) {
        console.log(chalk.yellow('kubectl not available - skipping pod restart'))
        console.log(chalk.yellow('Pods will pick up new artifacts on next restart'))
        return { skipped: true }
      } else {
        throw new Error(`Kubernetes deployment failed: ${error.message}`)
      }
    }
  }
}