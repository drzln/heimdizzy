import { execSync } from 'child_process'
import chalk from 'chalk'
import fs from 'fs/promises'
import path from 'path'
import { NpmDeploymentConfig } from '../config/schema.js'

export interface NpmDeploymentResult {
  packageName: string
  version: string
  registry: string
  tag: string
  published: boolean
}

export class NpmDeploymentService {
  async deploy(
    service: any,
    npmConfig: NpmDeploymentConfig,
    projectRoot: string,
    dryRun: boolean = false
  ): Promise<NpmDeploymentResult> {
    console.log(chalk.blue(`📦 NPM deployment for ${service.name}`))
    
    // Read package.json to get package name and version
    const packageJsonPath = path.join(projectRoot, 'package.json')
    const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8')
    const packageJson = JSON.parse(packageJsonContent)
    
    const packageName = packageJson.name
    const version = packageJson.version
    
    if (!packageName || !version) {
      throw new Error('Package name and version are required in package.json')
    }
    
    console.log(chalk.gray(`📋 Package: ${packageName}@${version}`))
    console.log(chalk.gray(`📋 Registry: ${npmConfig.registry}`))
    console.log(chalk.gray(`📋 Tag: ${npmConfig.tag}`))
    console.log(chalk.gray(`📋 Access: ${npmConfig.access}`))
    
    if (dryRun || npmConfig.dryRun) {
      console.log(chalk.yellow('[DRY RUN] Would publish package:'))
      console.log(`  Package: ${packageName}@${version}`)
      console.log(`  Registry: ${npmConfig.registry}`)
      console.log(`  Tag: ${npmConfig.tag}`)
      console.log(`  Access: ${npmConfig.access}`)
      
      return {
        packageName,
        version,
        registry: npmConfig.registry,
        tag: npmConfig.tag,
        published: false
      }
    }
    
    try {
      // Set up authentication
      const token = npmConfig.token || process.env.NPM_TOKEN
      if (!token) {
        throw new Error('NPM authentication token required. Set NPM_TOKEN environment variable or provide token in config.')
      }
      
      // Create .npmrc with auth token
      const npmrcPath = path.join(projectRoot, '.npmrc')
      const npmrcContent = `${npmConfig.registry.replace(/^https?:/, '')}:_authToken=${token}\n`
      await fs.writeFile(npmrcPath, npmrcContent)
      
      // Build publish command
      let publishCmd = `npm publish --registry ${npmConfig.registry}`
      
      if (npmConfig.tag !== 'latest') {
        publishCmd += ` --tag ${npmConfig.tag}`
      }
      
      if (npmConfig.access === 'public') {
        publishCmd += ' --access public'
      } else if (npmConfig.access === 'restricted') {
        publishCmd += ' --access restricted'
      }
      
      if (npmConfig.otp) {
        publishCmd += ` --otp ${npmConfig.otp}`
      }
      
      console.log(chalk.gray('Publishing package...'))
      
      // Execute publish command
      execSync(publishCmd, {
        cwd: projectRoot,
        stdio: 'inherit'
      })
      
      // Clean up .npmrc
      try {
        await fs.unlink(npmrcPath)
      } catch {
        // Ignore cleanup errors
      }
      
      console.log(chalk.green(`✓ Published ${packageName}@${version} to ${npmConfig.registry}`))
      
      return {
        packageName,
        version,
        registry: npmConfig.registry,
        tag: npmConfig.tag,
        published: true
      }
      
    } catch (error: any) {
      // Clean up .npmrc on error
      try {
        const npmrcPath = path.join(projectRoot, '.npmrc')
        await fs.unlink(npmrcPath)
      } catch {
        // Ignore cleanup errors
      }
      
      throw new Error(`NPM publish failed: ${error.message}`)
    }
  }
}