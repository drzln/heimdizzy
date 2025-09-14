import { execSync } from 'child_process'
import chalk from 'chalk'
import path from 'path'
import { DockerHubDeploymentConfig } from '../config/schema.js'

export interface DockerHubDeploymentResult {
  repository: string
  tag: string
  additionalTags: string[]
  pushed: boolean
  imageName: string
}

export class DockerHubDeploymentService {
  async deploy(
    service: any,
    dockerhubConfig: DockerHubDeploymentConfig,
    projectRoot: string,
    gitHash: string,
    dryRun: boolean = false
  ): Promise<DockerHubDeploymentResult> {
    console.log(chalk.blue(`🐳 Docker Hub deployment for ${service.name}`))
    
    const imageName = dockerhubConfig.repository
    const primaryTag = dockerhubConfig.tag === 'latest' ? gitHash : dockerhubConfig.tag
    const additionalTags = dockerhubConfig.tags || []
    
    // Always include latest if not already specified
    if (!additionalTags.includes('latest') && dockerhubConfig.tag !== 'latest') {
      additionalTags.push('latest')
    }
    
    console.log(chalk.gray(`📋 Repository: ${imageName}`))
    console.log(chalk.gray(`📋 Primary tag: ${primaryTag}`))
    console.log(chalk.gray(`📋 Additional tags: ${additionalTags.join(', ')}`))
    console.log(chalk.gray(`📋 Platforms: ${dockerhubConfig.platform.join(', ')}`))
    
    if (dryRun) {
      console.log(chalk.yellow('[DRY RUN] Would push Docker image:'))
      console.log(`  Repository: ${imageName}`)
      console.log(`  Tag: ${primaryTag}`)
      console.log(`  Additional tags: ${additionalTags.join(', ')}`)
      console.log(`  Platforms: ${dockerhubConfig.platform.join(', ')}`)
      
      return {
        repository: dockerhubConfig.repository,
        tag: primaryTag,
        additionalTags,
        pushed: false,
        imageName: `${imageName}:${primaryTag}`
      }
    }
    
    try {
      // Authenticate with Docker Hub
      const username = dockerhubConfig.username || process.env.DOCKER_USERNAME
      const password = dockerhubConfig.password || process.env.DOCKER_PASSWORD
      
      if (!username || !password) {
        throw new Error('Docker Hub credentials required. Set DOCKER_USERNAME and DOCKER_PASSWORD environment variables or provide in config.')
      }
      
      console.log(chalk.gray('Authenticating with Docker Hub...'))
      execSync(`echo "${password}" | docker login -u "${username}" --password-stdin`, {
        stdio: 'pipe'
      })
      
      // Set up buildx for multi-platform builds
      console.log(chalk.gray('Setting up Docker buildx...'))
      
      // Create builder instance if it doesn't exist
      try {
        execSync('docker buildx create --name heimdizzy-builder --use', { stdio: 'pipe' })
      } catch {
        // Builder might already exist, use it
        execSync('docker buildx use heimdizzy-builder', { stdio: 'pipe' })
      }
      
      // Bootstrap the builder
      execSync('docker buildx inspect --bootstrap', { stdio: 'inherit' })
      
      // Build the Docker image with all tags
      const dockerfilePath = path.join(projectRoot, dockerhubConfig.dockerfile)
      
      // Build command with buildx
      let buildCmd = `docker buildx build --push`
      
      // Add platforms
      buildCmd += ` --platform ${dockerhubConfig.platform.join(',')}`
      
      // Add primary tag
      buildCmd += ` -t ${imageName}:${primaryTag}`
      
      // Add additional tags
      for (const tag of additionalTags) {
        buildCmd += ` -t ${imageName}:${tag}`
      }
      
      // Add build args
      if (dockerhubConfig.buildArgs) {
        for (const [key, value] of Object.entries(dockerhubConfig.buildArgs)) {
          buildCmd += ` --build-arg ${key}="${value}"`
        }
      }
      
      // Add git hash as build arg
      buildCmd += ` --build-arg GIT_HASH="${gitHash}"`
      
      // Specify dockerfile and context
      buildCmd += ` -f ${dockerhubConfig.dockerfile} ${projectRoot}`
      
      console.log(chalk.gray('Building and pushing Docker image...'))
      console.log(chalk.gray(`Command: ${buildCmd}`))
      
      // Execute build and push
      execSync(buildCmd, {
        stdio: 'inherit'
      })
      
      // Clean up builder (optional, can be kept for future builds)
      try {
        execSync('docker buildx rm heimdizzy-builder', { stdio: 'pipe' })
      } catch {
        // Ignore cleanup errors
      }
      
      console.log(chalk.green(`✓ Pushed ${imageName}:${primaryTag} to Docker Hub`))
      console.log(chalk.green(`✓ Also tagged as: ${additionalTags.join(', ')}`))
      
      return {
        repository: dockerhubConfig.repository,
        tag: primaryTag,
        additionalTags,
        pushed: true,
        imageName: `${imageName}:${primaryTag}`
      }
      
    } catch (error: any) {
      throw new Error(`Docker Hub push failed: ${error.message}`)
    }
  }
}