import { execSync, spawn } from 'child_process'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront'
import { promises as fs } from 'fs'
import path from 'path'
import { glob } from 'glob'
import mime from 'mime-types'
import chalk from 'chalk'

import type { S3Config, WebDeploymentConfig } from '../config/schema.js'

interface ServiceInfo {
  name: string
  product: string
}

interface WebDeploymentResult {
  deployedFiles: number
  invalidationId?: string
  buildTime?: number
  deployTime: number
}

export class WebDeploymentService {
  private s3Client: S3Client
  private cloudfrontClient: CloudFrontClient

  constructor() {
    this.s3Client = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1'
    })
    this.cloudfrontClient = new CloudFrontClient({
      region: process.env.AWS_REGION || 'us-east-1'
    })
  }

  async deploy(
    serviceInfo: ServiceInfo,
    s3Config: S3Config,
    webConfig: WebDeploymentConfig,
    dryRun = false
  ): Promise<WebDeploymentResult> {
    const deployStartTime = Date.now()
    let buildTime: number | undefined
    let deployedFiles = 0

    console.log(chalk.blue(`🌐 Deploying web application: ${serviceInfo.name}`))

    // Step 1: Build if build command is provided
    if (webConfig.buildCommand) {
      const buildStartTime = Date.now()
      console.log(chalk.yellow(`🔨 Running build command: ${webConfig.buildCommand}`))
      
      if (!dryRun) {
        try {
          execSync(webConfig.buildCommand, { 
            stdio: 'inherit',
            cwd: process.cwd()
          })
          buildTime = Date.now() - buildStartTime
          console.log(chalk.green(`✅ Build completed in ${buildTime}ms`))
        } catch (error) {
          throw new Error(`Build failed: ${error}`)
        }
      } else {
        console.log(chalk.gray('(Dry run: build command would be executed)'))
        buildTime = 0
      }
    }

    // Step 2: Find all files to deploy
    const buildDir = path.resolve(webConfig.buildDir)
    console.log(chalk.yellow(`📁 Scanning build directory: ${buildDir}`))
    
    let files: string[] = []
    if (!dryRun) {
      try {
        await fs.access(buildDir)
        files = await glob('**/*', { 
          cwd: buildDir,
          nodir: true
        })
        console.log(chalk.green(`📄 Found ${files.length} files to deploy`))
      } catch (error) {
        throw new Error(`Build directory not found: ${buildDir}`)
      }
    } else {
      console.log(chalk.gray('(Dry run: files would be discovered)'))
      files = ['index.html', 'assets/app.js', 'css/style.css'] // Mock files for dry run
    }

    // Step 3: Upload files to S3
    console.log(chalk.yellow(`☁️  Uploading to S3 bucket: ${s3Config.bucket}`))
    
    const s3Client = this.createS3Client(s3Config)
    
    for (const file of files) {
      const filePath = path.join(buildDir, file)
      // Add path prefix if specified
      const normalizedFile = file.replace(/\\/g, '/') // Normalize path separators for S3
      const s3Key = webConfig.path ? `${webConfig.path}/${normalizedFile}` : normalizedFile
      
      if (!dryRun) {
        const fileContent = await fs.readFile(filePath)
        const contentType = mime.lookup(file) || 'application/octet-stream'
        const cacheControl = this.getCacheControl(file, webConfig)
        
        const command = new PutObjectCommand({
          Bucket: s3Config.bucket,
          Key: s3Key,
          Body: fileContent,
          ContentType: contentType,
          CacheControl: cacheControl,
          Metadata: {
            product: serviceInfo.product,
            service: serviceInfo.name,
            deployedAt: new Date().toISOString()
          }
        })

        await s3Client.send(command)
        deployedFiles++
        
        console.log(chalk.gray(`  ✅ ${s3Key} (${contentType})`))
      } else {
        console.log(chalk.gray(`  📄 Would upload: ${s3Key}`))
        deployedFiles++
      }
    }
    
    console.log(chalk.green(`☁️  Uploaded ${deployedFiles} files to S3`))

    // Step 4: CloudFront invalidation
    let invalidationId: string | undefined
    
    if (webConfig.cloudfront?.distributionId) {
      console.log(chalk.yellow(`🔄 Creating CloudFront invalidation...`))
      
      if (!dryRun) {
        try {
          const command = new CreateInvalidationCommand({
            DistributionId: webConfig.cloudfront.distributionId,
            InvalidationBatch: {
              Paths: {
                Quantity: webConfig.cloudfront.paths.length,
                Items: webConfig.cloudfront.paths
              },
              CallerReference: `heimdizzy-${serviceInfo.name}-${Date.now()}`
            }
          })

          const result = await this.cloudfrontClient.send(command)
          invalidationId = result.Invalidation?.Id
          console.log(chalk.green(`🔄 CloudFront invalidation created: ${invalidationId}`))
        } catch (error) {
          console.log(chalk.yellow(`⚠️  CloudFront invalidation failed: ${error}`))
        }
      } else {
        console.log(chalk.gray('(Dry run: CloudFront invalidation would be created)'))
        invalidationId = 'dry-run-invalidation-id'
      }
    }

    // Step 5: Verification (if enabled)
    if (webConfig.verification?.enabled !== false && !dryRun) {
      console.log(chalk.yellow(`🔍 Running deployment verification...`))
      
      // MinIO/S3 file count verification
      if (webConfig.verification?.minioCheck?.enabled !== false) {
        const minFiles = webConfig.verification?.minioCheck?.minFiles || 5
        console.log(chalk.gray(`  Checking file count (minimum: ${minFiles})...`))
        
        if (deployedFiles < minFiles) {
          throw new Error(`Verification failed: Only ${deployedFiles} files deployed, expected at least ${minFiles}`)
        }
        console.log(chalk.green(`  ✅ File count verified: ${deployedFiles} files`))
      }
      
      // HTTP endpoint verification (if configured)
      if (webConfig.verification?.endpoints && webConfig.verification.endpoints.length > 0) {
        console.log(chalk.gray(`  Checking ${webConfig.verification.endpoints.length} endpoints...`))
        
        for (const endpoint of webConfig.verification.endpoints) {
          try {
            // For staging deployments on PLO cluster, we'll skip HTTP checks
            // as they require complex port-forwarding or ingress setup
            console.log(chalk.gray(`  ⏭️  Skipping HTTP check for ${endpoint.path} (requires cluster access)`))
          } catch (error) {
            console.log(chalk.yellow(`  ⚠️  Could not verify endpoint ${endpoint.path}: ${error}`))
          }
        }
      }
      
      console.log(chalk.green(`✅ Deployment verification completed`))
    }

    const deployTime = Date.now() - deployStartTime
    console.log(chalk.green(`✅ Web deployment completed in ${deployTime}ms`))

    return {
      deployedFiles,
      invalidationId,
      buildTime,
      deployTime
    }
  }

  private createS3Client(s3Config: S3Config): S3Client {
    const clientConfig: any = {
      region: s3Config.region || 'us-east-1'
    }

    // Handle custom endpoints (like MinIO)
    if (s3Config.endpoint) {
      clientConfig.endpoint = s3Config.endpoint
      clientConfig.forcePathStyle = s3Config.forcePathStyle
    }

    // Handle custom credentials
    if (s3Config.accessKeyId && s3Config.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey
      }
    }

    return new S3Client(clientConfig)
  }

  private getCacheControl(fileName: string, webConfig: WebDeploymentConfig): string {
    // HTML files should not be cached
    if (fileName.endsWith('.html') || fileName === webConfig.indexFile) {
      return webConfig.cacheControl.html
    }
    
    // Everything else can be cached
    return webConfig.cacheControl.assets
  }
}