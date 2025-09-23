import { execSync } from 'child_process'
import chalk from 'chalk'
import { WebDeploymentService } from './web-deployment.js'
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
  service?: ServiceDeploymentResult
}

export class DeploymentService {
  private webDeploymentService = new WebDeploymentService()
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
    
    if (deployment.type === 'service') {
      return this.deployService(service, deployment, gitHash || 'latest', dryRun, deploymentConfig, fullConfig)
    }
    
    console.log(chalk.yellow(`Unknown deployment type: ${deployment.type}`))
    return { skipped: true }
  }

  private async deployService(
    service: any,
    deployment: any,
    gitHash: string,
    dryRun: boolean,
    deploymentConfig: any,
    fullConfig?: any
  ): Promise<DeploymentResult> {
    console.log(chalk.blue(`🚀 Starting service deployment for ${service.name}`))
    
    if (!deployment.service) {
      throw new Error('Service deployment configuration is required for service deploy type')
    }

    // Execute pre-build hooks if configured
    const hooks = deploymentConfig.hooks
    if (hooks?.pre_build) {
      await this.hooksService.executeHooks(hooks.pre_build, 'pre-build')
    }
    
    // Run the integrated service deployment
    const serviceResult = await this.serviceDeploymentService.deploy(
      service,
      deployment.service,
      gitHash,
      dryRun,
      deploymentConfig,
      fullConfig
    )
    
    // Execute post-build hooks if configured
    if (hooks?.post_build) {
      await this.hooksService.executeHooks(hooks.post_build, 'post-build')
    }
    
    return {
      podCount: serviceResult.podCount,
      service: serviceResult
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
}