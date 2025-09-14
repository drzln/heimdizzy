import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { mkdir } from 'fs/promises'
import chalk from 'chalk'
import type { BuildConfig } from '../config/schema.js'
import { SqlxService } from './sqlx.js'

export interface BuildResult {
  binaryPath: string
  gitHash: string
  buildId: string
  timestamp: string
}

export class BuildService {
  private containerName: string | null = null
  private sqlxService: SqlxService | null = null
  
  async build(service: any, config: BuildConfig, dryRun: boolean = false): Promise<BuildResult> {
    const gitHash = this.getGitHash()
    const buildId = `${Date.now()}-${gitHash.substring(0, 8)}`
    const timestamp = new Date().toISOString()
    
    console.log(chalk.gray(`Building ${service.name} (${gitHash})...`))
    
    // Initialize SQLx service
    this.sqlxService = new SqlxService(service.name)
    
    // Handle SQLx preparation if enabled
    if (config.sqlx?.enabled && !dryRun) {
      try {
        await this.sqlxService.prepareSqlx(config.sqlx)
      } catch (error) {
        console.error(chalk.red('SQLx preparation failed:'), (error as Error).message)
        // Optionally try to fix common issues
        if (config.sqlx.prepare?.autoGenerate) {
          await this.sqlxService.fixCompilationIssues(config.sqlx)
          // Retry once after fixing
          await this.sqlxService.prepareSqlx(config.sqlx)
        }
      }
    }
    
    if (dryRun) {
      console.log(chalk.yellow('[DRY RUN] Would build with:'))
      console.log(`  Platform: ${config.platform}`)
      console.log(`  Binary: ${config.binaryName}`)
      console.log(`  Features: ${config.features?.join(', ') || 'default'}`)
      return {
        binaryPath: '<dry-run>',
        gitHash,
        buildId,
        timestamp
      }
    }
    
    // Find the service root directory
    const serviceRoot = await this.findServiceRoot()
    const targetPath = join(serviceRoot, 'target')
    
    // Create target directory if needed
    await mkdir(targetPath, { recursive: true })
    
    let binaryPath: string
    
    if (config.useDocker) {
      binaryPath = await this.buildWithDocker(serviceRoot, targetPath, config)
    } else {
      // Direct cargo build
      const target = config.platform === 'x86_64' 
        ? 'x86_64-unknown-linux-gnu'
        : 'aarch64-unknown-linux-gnu'
      
      const features = config.features?.length 
        ? `--features ${config.features.join(',')}` 
        : ''
      
      const buildCommand = `cargo build --release --bin ${config.binaryName} --target ${target} ${features}`
      
      console.log(chalk.gray(`Running: ${buildCommand}`))
      
      try {
        execSync(buildCommand, {
          cwd: serviceRoot,
          stdio: 'inherit'
        })
      } catch (error: any) {
        throw new Error(`Build failed: ${error.message}`)
      }
      
      binaryPath = join(serviceRoot, 'target', target, 'release', config.binaryName)
    }
    
    if (!existsSync(binaryPath)) {
      throw new Error(`Build did not produce binary at ${binaryPath}`)
    }
    
    return {
      binaryPath,
      gitHash,
      buildId,
      timestamp
    }
  }
  
  private getGitHash(): string {
    try {
      return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
    } catch {
      console.warn(chalk.yellow('Could not get git hash, using timestamp'))
      return Date.now().toString(36)
    }
  }
  
  private async findServiceRoot(): Promise<string> {
    let dir = process.cwd()
    
    while (dir !== '/') {
      if (existsSync(join(dir, 'Cargo.toml'))) {
        return dir
      }
      dir = dirname(dir)
    }
    
    throw new Error('Could not find service root (no Cargo.toml found)')
  }
  
  private async buildWithDocker(serviceRoot: string, targetPath: string, config: BuildConfig): Promise<string> {
    this.containerName = `heimdizzy-build-${Date.now()}`
    const bootstrapPath = join(targetPath, 'bootstrap')
    
    console.log(chalk.gray(`Building with Docker container ${this.containerName}...`))
    
    try {
      // Build Docker image
      const dockerfilePath = join(serviceRoot, config.dockerfile)
      if (!existsSync(dockerfilePath)) {
        throw new Error(`Dockerfile not found: ${dockerfilePath}`)
      }
      
      execSync(`docker build -t ${this.containerName} -f ${config.dockerfile} .`, {
        cwd: serviceRoot,
        stdio: 'inherit'
      })
      
      // Extract binary from container
      execSync(`docker run --rm -v "${targetPath}:/output" ${this.containerName} cp /bootstrap /output/bootstrap`, {
        stdio: 'inherit'
      })
      
      // Cleanup container image if requested
      if (config.cleanupContainer) {
        this.cleanup()
      }
      
      return bootstrapPath
    } catch (error: any) {
      // Always try to cleanup on error
      this.cleanup()
      throw new Error(`Docker build failed: ${error.message}`)
    }
  }
  
  cleanup(): void {
    if (this.containerName) {
      try {
        console.log(chalk.gray(`Cleaning up Docker image ${this.containerName}...`))
        execSync(`docker rmi ${this.containerName}`, { stdio: 'pipe' })
        
        // Also cleanup Docker build cache to ensure fresh builds
        console.log(chalk.gray('Cleaning up Docker build cache...'))
        execSync('docker builder prune -f', { stdio: 'pipe' })
        
        console.log(chalk.green('✓ Docker image and build cache cleaned up'))
      } catch {
        console.warn(chalk.yellow(`Failed to remove Docker image ${this.containerName}`))
      }
      this.containerName = null
    }
  }
}