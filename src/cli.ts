#!/usr/bin/env node
import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { execSync } from 'child_process'
import { ConfigLoader } from './config/loader.js'
import { BuildService } from './services/build.js'
import { UploadService } from './services/upload.js'
import { DeploymentService } from './services/deployment.js'
import { WebhookService, type WebhookEvent } from './services/webhook.js'

const program = new Command()

// Global cleanup tracking
const cleanupHandlers: (() => void)[] = []

// Register cleanup on exit
process.on('exit', () => {
  cleanupHandlers.forEach(handler => handler())
})

// Handle interrupts
process.on('SIGINT', () => {
  console.log(chalk.yellow('\n\nInterrupted, cleaning up...'))
  process.exit(1)
})

process.on('SIGTERM', () => {
  console.log(chalk.yellow('\n\nTerminated, cleaning up...'))
  process.exit(1)
})

program
  .name('heimdizzy')
  .description('Universal deployment tool for Lambda and container services')
  .version('0.1.0')

program
  .command('deploy <environment>')
  .description('Deploy service to the specified environment')
  .option('-c, --config <path>', 'Path to heimdizzy.yml', 'heimdizzy.yml')
  .option('-p, --product <product>', 'Override the product for deployment (e.g., novaskyn, lilith, thai)')
  .option('--skip-build', 'Skip the build step')
  .option('--skip-upload', 'Skip the upload step')
  .option('--dry-run', 'Show what would be deployed without actually deploying')
  .action(async (environment, options) => {
    const spinner = ora()
    const startTime = Date.now()
    const webhookService = new WebhookService()
    
    // Helper to send notifications
    const notify = async (event: WebhookEvent, message: string, details?: any) => {
      if (!config || !configLoader) return
      
      const deploymentConfig = configLoader.getDeploymentConfig(config, environment)
      const notifications = deploymentConfig.notifications
      
      // Check if notifications are enabled and this specific event is enabled
      if (notifications?.enabled !== false && notifications?.events?.[event] !== false) {
        await webhookService.sendNotification(
          notifications?.webhook,
          {
            service: config.service.name,
            product: config.service.product,
            environment,
            event,
            message,
            timestamp: new Date().toISOString(),
            details
          },
          notifications?.rateLimitDelay
        )
      }
    }
    
    let config: any
    let configLoader: ConfigLoader
    
    try {
      // Load configuration
      spinner.start('Loading configuration...')
      configLoader = new ConfigLoader()
      config = await configLoader.load(options.config)
      
      // Override product if provided via CLI
      if (options.product) {
        config.service.product = options.product
      }
      
      const deploymentConfig = configLoader.getDeploymentConfig(config, environment)
      spinner.succeed('Configuration loaded')
      
      console.log(chalk.blue(`\nDeploying ${config.service.name} (${config.service.product}) to ${environment}`))
      
      // Check for dry run mode
      if (options.dryRun) {
        await notify('dryRun', `Dry run deployment of ${config.service.name} to ${environment}`)
      }
      
      // Send start notification
      await notify('deployStart', `Starting deployment of ${config.service.name} to ${environment}`)
      
      // Get git hash for all deployments
      let gitHash: string
      try {
        gitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
      } catch {
        console.warn(chalk.yellow('Could not get git hash, using timestamp'))
        gitHash = Date.now().toString(36)
      }
      
      // Build
      let buildService: BuildService | null = null
      let buildResult: any = null
      const skipBuildTypes = ['web', 'container', 'npm', 'dockerhub']
      if (!options.skipBuild && config.build && !skipBuildTypes.includes(deploymentConfig.deployment.type)) {
        const buildStartTime = Date.now()
        await notify('buildStart', `Building ${config.service.name} with Docker`)
        
        spinner.start('Building service...')
        buildService = new BuildService()
        
        // Register cleanup
        cleanupHandlers.push(() => buildService?.cleanup())
        
        buildResult = await buildService.build(config.service, config.build, options.dryRun)
        spinner.succeed('Build completed')
        
        const buildDuration = Date.now() - buildStartTime
        await notify('buildSuccess', `Build completed for ${config.service.name}`, {
          duration: buildDuration,
          gitHash: buildResult?.gitHash
        })
      } else if (options.skipBuild) {
        await notify('buildSkipped', `Build skipped for ${config.service.name}`)
      }
      
      // Upload
      let artifactPath: string | undefined
      const skipUploadTypes = ['web', 'container', 'npm', 'dockerhub']
      if (!options.skipUpload && !skipUploadTypes.includes(deploymentConfig.deployment.type)) {
        const uploadStartTime = Date.now()
        await notify('uploadStart', `Uploading artifacts for ${config.service.name}`)
        
        spinner.start('Uploading artifacts...')
        const uploadService = new UploadService()
        artifactPath = await uploadService.upload(
          config.service,
          deploymentConfig,
          options.dryRun
        )
        spinner.succeed(`Artifacts uploaded to ${artifactPath}`)
        
        const uploadDuration = Date.now() - uploadStartTime
        await notify('uploadSuccess', `Upload completed for ${config.service.name}`, {
          duration: uploadDuration,
          artifactPath
        })
      } else if (options.skipUpload) {
        await notify('uploadSkipped', `Upload skipped for ${config.service.name}`)
      }
      
      // Deploy
      spinner.start('Deploying service...')
      const deploymentService = new DeploymentService()
      
      // Send deployment type specific notification
      if (!options.dryRun) {
        if (deploymentConfig.deployment.type === 'service') {
          await notify('podsRestarting', `Restarting pods for ${config.service.name}`)
        } else if (deploymentConfig.deployment.type === 'web') {
          await notify('webDeploying', `Deploying web assets for ${config.service.name}`)
        }
      }
      
      const deployResult = await deploymentService.deploy(
        config.service,
        deploymentConfig,
        options.dryRun,
        buildResult?.gitHash || gitHash,
        config
      )
      
      spinner.succeed('Deployment completed')
      
      // Send deployment success details
      if (deployResult.podCount !== undefined && deployResult.podCount > 0) {
        await notify('podsReady', `${deployResult.podCount} pod(s) ready for ${config.service.name}`, {
          count: deployResult.podCount,
          podStatus: deployResult.podStatus
        })
      } else if (deployResult.deployedFiles !== undefined) {
        await notify('webDeployed', `${deployResult.deployedFiles} files deployed for ${config.service.name}`, {
          filesDeployed: deployResult.deployedFiles,
          invalidationId: deployResult.invalidationId,
          buildTime: deployResult.buildTime,
          deployTime: deployResult.deployTime
        })
      }
      
      console.log(chalk.green(`\n✓ ${config.service.name} deployed successfully to ${environment}`))
      
      // Send success notification
      const duration = Date.now() - startTime
      await notify('deploySuccess', `Successfully deployed ${config.service.name} to ${environment}`, {
        duration,
        gitHash: buildResult?.gitHash || 'unknown'
      })
      
      // Cleanup after successful deployment
      if (buildService && config.build?.cleanupContainer) {
        buildService.cleanup()
        await notify('cleanup', `Docker cleanup completed for ${config.service.name}`)
      }
      
    } catch (error: any) {
      spinner.fail()
      console.error(chalk.red('\nDeployment failed:'), error)
      
      // Send error notification
      if (config) {
        await notify('deployError', `Failed to deploy ${config.service.name} to ${environment}`, {
          error: error.message || String(error),
          duration: Date.now() - startTime
        })
      }
      
      process.exit(1)
    }
  })

program
  .command('validate')
  .description('Validate heimdizzy.yml configuration')
  .option('-c, --config <path>', 'Path to heimdizzy.yml', 'heimdizzy.yml')
  .action(async (options) => {
    try {
      const configLoader = new ConfigLoader()
      await configLoader.load(options.config)
      console.log(chalk.green('✓ Configuration is valid'))
    } catch (error) {
      console.error(chalk.red('✗ Configuration is invalid:'), error)
      process.exit(1)
    }
  })

program
  .command('cleanup')
  .description('Clean up Docker images and temporary files')
  .option('--images', 'Clean up Docker images', true)
  .option('--pattern <pattern>', 'Docker image pattern to clean', 'heimdizzy-build-*')
  .action(async (options) => {
    const spinner = ora()
    
    try {
      if (options.images) {
        spinner.start('Cleaning up Docker images...')
        const { execSync } = await import('child_process')
        
        // List and remove heimdizzy build images
        try {
          const images = execSync(`docker images --format "{{.Repository}}:{{.Tag}}" | grep "${options.pattern}" || true`, {
            encoding: 'utf-8'
          }).trim()
          
          if (images) {
            const imageList = images.split('\n').filter(img => img)
            console.log(chalk.gray(`\nFound ${imageList.length} images to clean:`))
            imageList.forEach(img => console.log(chalk.gray(`  - ${img}`)))
            
            execSync(`docker rmi -f ${imageList.join(' ')}`, { stdio: 'inherit' })
            spinner.succeed(`Cleaned up ${imageList.length} Docker images`)
          } else {
            spinner.info('No Docker images to clean up')
          }
        } catch (e) {
          spinner.warn('Failed to clean some Docker images')
        }
      }
      
      console.log(chalk.green('\n✓ Cleanup completed'))
    } catch (error) {
      spinner.fail()
      console.error(chalk.red('Cleanup failed:'), error)
      process.exit(1)
    }
  })

program.parse()