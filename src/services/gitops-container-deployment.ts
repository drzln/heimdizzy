import { execSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import chalk from 'chalk'
import * as yaml from 'js-yaml'
import { HooksService } from './hooks.js'
import { Hooks } from '../config/schema.js'

export interface GitOpsContainerDeploymentResult {
  imageName: string
  imageTag: string
  manifestUpdated: boolean
  commitHash: string
  prCreated: boolean
}

export class GitOpsContainerDeploymentService {
  private hooksService = new HooksService()

  async deploy(
    service: any,
    config: any,
    gitHash: string,
    dryRun: boolean = false,
    hooks?: Hooks,
    deploymentConfig?: any,
    fullConfig?: any
  ): Promise<GitOpsContainerDeploymentResult> {
    console.log(chalk.blue(`🚀 GitOps container deployment for ${service.name}`))
    
    const { registry, kubernetes } = config
    const imageTag = `${gitHash}-${Date.now()}`
    const fullImageName = `${registry.endpoint}/${registry.repository}:${imageTag}`
    const latestImageName = `${registry.endpoint}/${registry.repository}:latest`
    
    if (dryRun) {
      console.log(chalk.yellow('[DRY RUN] Would deploy container:'))
      console.log(`  Image: ${fullImageName}`)
      console.log(`  Registry: ${registry.endpoint}`)
      console.log(`  Namespace: ${kubernetes.namespace}`)
      return {
        imageName: fullImageName,
        imageTag: imageTag,
        manifestUpdated: false,
        commitHash: gitHash,
        prCreated: false
      }
    }
    
    try {
      // Execute pre-deploy hooks
      if (hooks?.pre_deploy) {
        await this.hooksService.executeHooks(hooks.pre_deploy, 'pre-deploy')
      }

      // 1. Build container image (pre-build hooks already executed at deployment level)
      console.log(chalk.gray('Building container image...'))
      
      // Get dockerfile from deployment config if available, otherwise use default
      const dockerfile = deploymentConfig?.build?.dockerfile || 'Dockerfile'
      
      // Check if the specified dockerfile exists
      if (!existsSync(dockerfile)) {
        throw new Error(`Dockerfile not found: ${dockerfile}`)
      }
      
      execSync(`docker build -f ${dockerfile} -t ${service.name}:${imageTag} .`, {
        stdio: 'inherit'
      })

      // Execute post-build hooks
      if (hooks?.post_build) {
        await this.hooksService.executeHooks(hooks.post_build, 'post-build')
      }
      
      // 2. Tag for registry
      console.log(chalk.gray(`Tagging image for registry: ${fullImageName}`))
      execSync(`docker tag ${service.name}:${imageTag} ${fullImageName}`, {
        stdio: 'inherit'
      })
      
      // Also tag as latest
      execSync(`docker tag ${service.name}:${imageTag} ${latestImageName}`, {
        stdio: 'inherit'
      })
      
      // 3. Push to registry
      console.log(chalk.gray('Pushing image to registry...'))
      
      // For in-cluster registries, use NodePort
      if (registry.endpoint.includes('svc.cluster.local')) {
        console.log(chalk.yellow('Detected in-cluster registry, using NodePort for push...'))
        
        // Get the NodePort from config or auto-discover
        let nodePort: number
        if (registry.nodePort) {
          nodePort = registry.nodePort
        } else {
          const nodePortOutput = execSync(
            `kubectl get svc -n ${registry.namespace} docker-registry-nodeport -o jsonpath='{.spec.ports[0].nodePort}'`,
            { encoding: 'utf-8' }
          ).trim()
          nodePort = parseInt(nodePortOutput) || 30500
        }
        const nodePortRegistry = `localhost:${nodePort}`
        const nodePortImageName = `${nodePortRegistry}/${registry.repository}:${imageTag}`
        const nodePortLatestName = `${nodePortRegistry}/${registry.repository}:latest`
        
        // Tag for NodePort registry
        execSync(`docker tag ${service.name}:${imageTag} ${nodePortImageName}`, {
          stdio: 'inherit'
        })
        execSync(`docker tag ${service.name}:${imageTag} ${nodePortLatestName}`, {
          stdio: 'inherit'
        })
        
        // Push through NodePort
        execSync(`docker push ${nodePortImageName}`, {
          stdio: 'inherit'
        })
        execSync(`docker push ${nodePortLatestName}`, {
          stdio: 'inherit'
        })
        
        console.log(chalk.green('✓ Image pushed to in-cluster registry'))
      } else {
        // External registry
        execSync(`docker push ${fullImageName}`, {
          stdio: 'inherit'
        })
        execSync(`docker push ${latestImageName}`, {
          stdio: 'inherit'
        })
      }
      
      // 4. Update kustomization.yaml with new image tag
      console.log(chalk.gray('Updating kustomization.yaml with new image tag...'))
      
      // Find the kustomization.yaml file
      let possiblePaths: string[] = []
      
      // If custom gitOpsPath is provided, use it
      if (kubernetes.gitOpsPath) {
        const customPath = kubernetes.gitOpsPath.endsWith('/kustomization.yaml') 
          ? kubernetes.gitOpsPath 
          : join(kubernetes.gitOpsPath, 'kustomization.yaml')
        const projectRoot = fullConfig?.global?.projectRoot || process.cwd()
        possiblePaths = [
          join(projectRoot, customPath),
          customPath
        ]
      } else {
        // Default paths
        const projectRoot = fullConfig?.global?.projectRoot || process.cwd()
        const gitOpsBasePath = deploymentConfig?.global?.gitOpsBasePath || 'k8s/clusters/main'
        possiblePaths = [
          `${projectRoot}/${gitOpsBasePath}/infrastructure/${kubernetes.namespace}/services/${service.name}/kustomization.yaml`,
          `${gitOpsBasePath}/infrastructure/${kubernetes.namespace}/services/${service.name}/kustomization.yaml`,
        ]
      }
      
      let kustomizationPath: string | null = null
      for (const path of possiblePaths) {
        const fullPath = path.startsWith('/') ? path : join(process.cwd(), '../../..', path)
        if (existsSync(fullPath)) {
          kustomizationPath = fullPath
          break
        }
      }
      
      if (!kustomizationPath) {
        // Create kustomization.yaml if it doesn't exist
        let serviceDir: string
        if (kubernetes.gitOpsPath) {
          const customDir = kubernetes.gitOpsPath.endsWith('/kustomization.yaml') 
            ? dirname(kubernetes.gitOpsPath)
            : kubernetes.gitOpsPath
          const projectRoot = fullConfig?.global?.projectRoot || process.cwd()
          serviceDir = join(projectRoot, customDir)
        } else {
          const projectRoot = fullConfig?.global?.projectRoot || process.cwd()
          const gitOpsBasePath = fullConfig?.global?.gitOpsBasePath || 'k8s/clusters/main'
          serviceDir = `${projectRoot}/${gitOpsBasePath}/infrastructure/${kubernetes.namespace}/services/${service.name}`
        }
        kustomizationPath = join(serviceDir, 'kustomization.yaml')
        
        const kustomization = {
          apiVersion: 'kustomize.config.k8s.io/v1beta1',
          kind: 'Kustomization',
          namespace: kubernetes.namespace,
          resources: [
            'email-service.yaml',
            'email-configmap.yaml',
            'email-hpa.yaml',
            'email-network-policy.yaml'
          ],
          images: [{
            name: `${registry.endpoint}/${registry.repository}`,
            newTag: imageTag
          }]
        }
        
        writeFileSync(kustomizationPath, yaml.dump(kustomization, { lineWidth: -1 }))
        console.log(chalk.green(`✓ Created kustomization.yaml at ${kustomizationPath}`))
      } else {
        // Update existing kustomization.yaml
        const kustomizationContent = readFileSync(kustomizationPath, 'utf-8')
        const kustomization = yaml.load(kustomizationContent) as any
        
        if (!kustomization.images) {
          kustomization.images = []
        }
        
        // Find and update the image entry
        const imageEntry = kustomization.images.find((img: any) => 
          img.name === `${registry.endpoint}/${registry.repository}` ||
          img.name === registry.repository
        )
        
        if (imageEntry) {
          imageEntry.newTag = imageTag
        } else {
          kustomization.images.push({
            name: `${registry.endpoint}/${registry.repository}`,
            newTag: imageTag
          })
        }
        
        writeFileSync(kustomizationPath, yaml.dump(kustomization, { lineWidth: -1 }))
        console.log(chalk.green(`✓ Updated kustomization.yaml with new tag: ${imageTag}`))
      }
      
      // 5. Commit and push changes
      console.log(chalk.gray('Committing manifest changes...'))
      
      const kustomizationDir = dirname(kustomizationPath)
      const commitMessage = `chore(k8s): update ${service.name} image to ${imageTag}`
      
      try {
        execSync(`git add ${kustomizationPath}`, { cwd: kustomizationDir })
        execSync(`git commit -m "${commitMessage}"`, { cwd: kustomizationDir })
        execSync(`git push origin main`, { cwd: kustomizationDir })
        
        console.log(chalk.green('✓ Changes committed and pushed to Git'))
        console.log(chalk.blue('FluxCD will detect and apply the changes automatically'))
      } catch (error: any) {
        if (error.message.includes('nothing to commit')) {
          console.log(chalk.yellow('No changes to commit (image tag might be the same)'))
        } else {
          console.warn(chalk.yellow('Failed to commit/push changes. You may need to commit manually.'))
          console.log(chalk.gray(`Suggested commit: ${commitMessage}`))
        }
      }
      
      // 6. Monitor deployment (optional)
      console.log(chalk.gray('\nTo monitor the deployment:'))
      console.log(chalk.gray(`  kubectl -n ${kubernetes.namespace} get pods -l app=${service.name} -w`))
      console.log(chalk.gray(`  flux logs -n ${kubernetes.fluxNamespace} -f`))
      
      // Execute post-deploy hooks
      if (hooks?.post_deploy) {
        await this.hooksService.executeHooks(hooks.post_deploy, 'post-deploy')
      }

      // Clean up local images
      console.log(chalk.gray('\nCleaning up local images...'))
      try {
        execSync(`docker rmi ${service.name}:${imageTag}`, { stdio: 'pipe' })
      } catch (error) {
        // Ignore cleanup errors
      }
      
      return {
        imageName: fullImageName,
        imageTag: imageTag,
        manifestUpdated: true,
        commitHash: gitHash,
        prCreated: false
      }
      
    } catch (error: any) {
      throw new Error(`GitOps container deployment failed: ${error.message}`)
    }
  }
}