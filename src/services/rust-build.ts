import { execSync } from 'child_process'
import chalk from 'chalk'
import * as fs from 'fs'
import * as path from 'path'

export interface RustBuildOptions {
  dockerfile?: string
  platform?: string
  features?: string[]
}

export class RustBuildService {
  
  async buildDockerImage(
    serviceName: string,
    tag: string,
    dockerfile: string = 'Dockerfile',
    buildArgs?: Record<string, string>
  ): Promise<void> {
    console.log(chalk.gray(`📦 Building Docker image for ${serviceName}...`))
    
    // Prepare build arguments
    const args = []
    if (buildArgs) {
      for (const [key, value] of Object.entries(buildArgs)) {
        args.push(`--build-arg ${key}=${value}`)
      }
    }
    
    // Build the image
    const buildCommand = `docker build -f ${dockerfile} ${args.join(' ')} -t ${serviceName}:${tag} .`
    console.log(chalk.gray(`  Command: ${buildCommand}`))
    
    execSync(buildCommand, { stdio: 'inherit' })
    console.log(chalk.green(`✓ Docker image built: ${serviceName}:${tag}`))
  }
}