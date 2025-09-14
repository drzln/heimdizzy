import { S3Client, PutObjectCommand, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3'
import { createReadStream, statSync, existsSync, unlinkSync } from 'fs'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { execSync } from 'child_process'
import archiver from 'archiver'
import { createWriteStream } from 'fs'
import { join } from 'path'
import chalk from 'chalk'
import type { BuildResult } from './build.js'
import type { HeimdizzyConfig } from '../config/schema.js'

export class UploadService {
  async upload(
    service: any, 
    deploymentConfig: any, 
    dryRun: boolean = false
  ): Promise<string> {
    const buildResult = await this.getBuildResult()
    const { storage, deployment } = deploymentConfig
    
    if (deployment.type === 'lambda-zip') {
      return this.uploadLambdaZip(service, buildResult, storage, deploymentConfig, dryRun)
    }
    
    if (deployment.type === 'web') {
      // Web deployments handle their own file upload in the deployment service
      console.log(chalk.yellow('Skipping upload for web deployment - handled in deployment phase'))
      return 'web-deployment-no-artifacts'
    }
    
    throw new Error(`Deployment type ${deployment.type} not yet supported`)
  }
  
  private async uploadLambdaZip(
    service: any,
    buildResult: BuildResult,
    storage: any,
    deploymentConfig: any,
    dryRun: boolean
  ): Promise<string> {
    const version = `v${buildResult.gitHash}`
    const zipFileName = `lambda-${version}.zip`
    const zipPath = join(process.cwd(), 'target', zipFileName)
    
    console.log(chalk.gray(`Creating Lambda ZIP package...`))
    
    if (!dryRun) {
      // Create ZIP package
      await this.createZipPackage(buildResult.binaryPath, zipPath)
      
      // Clean up bootstrap file if it exists
      const bootstrapPath = join(process.cwd(), 'target/bootstrap')
      if (existsSync(bootstrapPath)) {
        unlinkSync(bootstrapPath)
        console.log(chalk.gray('✓ Cleaned up bootstrap file'))
      }
    }
    
    // Calculate file hash
    const fileHash = dryRun ? 'dry-run-hash' : await this.calculateFileHash(zipPath)
    
    // Upload to S3/MinIO
    const s3Key = `${service.name}/lambda-${version}.zip`
    const latestKey = `${service.name}/lambda-latest.zip`
    
    if (dryRun) {
      console.log(chalk.yellow('[DRY RUN] Would upload:'))
      console.log(`  Bucket: ${storage.bucket}`)
      console.log(`  Key: ${s3Key}`)
      console.log(`  Latest: ${latestKey}`)
      console.log(`  Hash: ${fileHash}`)
      return `s3://${storage.bucket}/${s3Key}`
    }
    
    const s3Client = this.createS3Client(storage)
    
    // Ensure bucket exists
    await this.ensureBucket(s3Client, storage.bucket)
    
    // Upload versioned artifact
    await this.uploadFile(s3Client, storage.bucket, s3Key, zipPath, {
      'git-hash': buildResult.gitHash,
      'build-timestamp': buildResult.timestamp,
      'file-hash': fileHash,
      'service': service.name,
      'environment': deploymentConfig.environment
    })
    
    // Upload as latest
    await this.uploadFile(s3Client, storage.bucket, latestKey, zipPath, {
      'git-hash': buildResult.gitHash,
      'build-timestamp': buildResult.timestamp,
      'file-hash': fileHash,
      'service': service.name,
      'environment': deploymentConfig.environment
    })
    
    return `s3://${storage.bucket}/${s3Key}`
  }
  
  private createS3Client(storage: any): S3Client {
    const endpoint = storage.endpoint || process.env.MINIO_ENDPOINT
    const accessKeyId = storage.accessKeyId || process.env.MINIO_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID
    const secretAccessKey = storage.secretAccessKey || process.env.MINIO_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY
    
    return new S3Client({
      region: storage.region,
      endpoint,
      forcePathStyle: storage.forcePathStyle,
      credentials: endpoint ? {
        accessKeyId: accessKeyId,
        secretAccessKey: secretAccessKey
      } : undefined
    })
  }
  
  private async ensureBucket(client: S3Client, bucket: string): Promise<void> {
    try {
      // First check if bucket exists
      await client.send(new HeadBucketCommand({ Bucket: bucket }))
      console.log(chalk.gray(`✓ Bucket ${bucket} exists`))
    } catch (e: any) {
      // If bucket doesn't exist, create it
      if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) {
        try {
          console.log(chalk.gray(`Creating bucket ${bucket}...`))
          await client.send(new CreateBucketCommand({ Bucket: bucket }))
          console.log(chalk.green(`✓ Bucket ${bucket} created`))
        } catch (createError: any) {
          if (createError.name === 'BucketAlreadyOwnedByYou' || createError.Code === 'BucketAlreadyExists') {
            console.log(chalk.gray(`✓ Bucket ${bucket} exists`))
          } else {
            throw new Error(`Failed to create bucket: ${createError.message}`)
          }
        }
      } else {
        throw new Error(`Failed to check bucket: ${e.message}`)
      }
    }
  }
  
  private async uploadFile(
    client: S3Client, 
    bucket: string, 
    key: string, 
    filePath: string,
    metadata: Record<string, string>
  ): Promise<void> {
    const fileStream = createReadStream(filePath)
    const stats = statSync(filePath)
    
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fileStream,
      ContentType: 'application/zip',
      ContentLength: stats.size,
      Metadata: metadata
    }))
    
    console.log(chalk.green(`✓ Uploaded ${key} (${this.formatBytes(stats.size)})`))
  }
  
  private async createZipPackage(binaryPath: string, zipPath: string): Promise<void> {
    const output = createWriteStream(zipPath)
    const archive = archiver('zip', {
      zlib: { level: 9 }
    })
    
    archive.on('error', (err) => {
      throw err
    })
    
    archive.pipe(output)
    
    // Add the binary as 'bootstrap' for Lambda
    archive.file(binaryPath, { 
      name: 'bootstrap',
      mode: 0o755
    })
    
    await archive.finalize()
    
    await new Promise<void>((resolve, reject) => {
      output.on('close', () => resolve())
      output.on('error', reject)
    })
  }
  
  private async calculateFileHash(filePath: string): Promise<string> {
    const fileBuffer = readFileSync(filePath)
    const hash = createHash('sha256')
    hash.update(fileBuffer)
    return hash.digest('hex')
  }
  
  private formatBytes(bytes: number): string {
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    if (bytes === 0) return '0 Bytes'
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i]
  }
  
  private async getBuildResult(): Promise<BuildResult> {
    // In a real implementation, this would be passed from the build step
    // For now, we'll reconstruct it
    const gitHash = this.getGitHash()
    const buildId = `${Date.now()}-${gitHash.substring(0, 8)}`
    
    // Check for Docker-built bootstrap first, then fallback to direct build
    const targetPath = join(process.cwd(), 'target')
    const bootstrapPath = join(targetPath, 'bootstrap')
    let binaryPath = bootstrapPath
    
    if (!existsSync(bootstrapPath)) {
      binaryPath = join(targetPath, 'x86_64-unknown-linux-gnu/release/lambda')
    }
    
    return {
      binaryPath,
      gitHash,
      buildId,
      timestamp: new Date().toISOString()
    }
  }
  
  private getGitHash(): string {
    try {
      return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
    } catch {
      return Date.now().toString(36)
    }
  }
}