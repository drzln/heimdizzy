import chalk from 'chalk'

export type WebhookEvent = 
  | 'deployStart' | 'deploySuccess' | 'deployError'
  | 'buildStart' | 'buildSuccess' | 'buildSkipped' 
  | 'uploadStart' | 'uploadSuccess' | 'uploadSkipped'
  | 'podsRestarting' | 'podsReady'
  | 'webDeploying' | 'webDeployed'
  | 'cleanup' | 'dryRun'

export interface WebhookPayload {
  service: string
  product: string
  environment: string
  event: WebhookEvent
  message: string
  timestamp: string
  details?: {
    gitHash?: string
    buildId?: string
    error?: string
    duration?: number
    size?: string
    count?: number
    artifactPath?: string
    podStatus?: string
    filesDeployed?: number
    invalidationId?: string
    buildTime?: number
    deployTime?: number
  }
}

export class WebhookService {
  async sendNotification(
    webhookUrl: string | undefined, 
    payload: WebhookPayload,
    rateLimitDelay: number = 2000
  ): Promise<void> {
    if (!webhookUrl) {
      return
    }
    
    try {
      const embed = this.createDiscordEmbed(payload)
      
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          embeds: [embed]
        })
      })
      
      // Check for Discord rate limiting
      if (response.status === 429) {
        const retryAfter = response.headers.get('X-RateLimit-Reset-After')
        const delay = retryAfter ? parseInt(retryAfter) * 1000 : rateLimitDelay
        
        console.warn(chalk.yellow(`Discord rate limit hit. Waiting ${delay}ms before continuing...`))
        await new Promise(resolve => setTimeout(resolve, delay))
        
        // Don't retry the notification, just continue with deployment
        return
      }
      
      if (!response.ok) {
        console.warn(chalk.yellow(`Webhook notification failed: ${response.status}`))
      }
    } catch (error) {
      // Don't fail deployment if webhook fails
      console.warn(chalk.yellow('Failed to send webhook notification'), error)
    }
  }
  
  private createDiscordEmbed(payload: WebhookPayload) {
    const eventConfig: Record<WebhookEvent, { color: number, icon: string, title: string }> = {
      deployStart: { color: 0x3498db, icon: '🚀', title: 'Deployment Started' },
      deploySuccess: { color: 0x2ecc71, icon: '✅', title: 'Deployment Completed' },
      deployError: { color: 0xe74c3c, icon: '❌', title: 'Deployment Failed' },
      buildStart: { color: 0x9b59b6, icon: '🔨', title: 'Build Started' },
      buildSuccess: { color: 0x2ecc71, icon: '✅', title: 'Build Completed' },
      buildSkipped: { color: 0xf39c12, icon: '⏭️', title: 'Build Skipped' },
      uploadStart: { color: 0x3498db, icon: '📤', title: 'Upload Started' },
      uploadSuccess: { color: 0x2ecc71, icon: '✅', title: 'Upload Completed' },
      uploadSkipped: { color: 0xf39c12, icon: '⏭️', title: 'Upload Skipped' },
      podsRestarting: { color: 0x3498db, icon: '🔄', title: 'Restarting Pods' },
      podsReady: { color: 0x2ecc71, icon: '✅', title: 'Pods Ready' },
      webDeploying: { color: 0x3498db, icon: '🌐', title: 'Deploying Web Assets' },
      webDeployed: { color: 0x2ecc71, icon: '🌐', title: 'Web Assets Deployed' },
      cleanup: { color: 0x95a5a6, icon: '🧹', title: 'Cleanup Completed' },
      dryRun: { color: 0xe67e22, icon: '🧪', title: 'Dry Run Mode' }
    }
    
    const config = eventConfig[payload.event] || { color: 0x95a5a6, icon: '📝', title: 'Notification' }
    
    const embed: any = {
      title: `${config.icon} ${config.title}`,
      description: payload.message,
      color: config.color,
      fields: [
        {
          name: 'Product',
          value: payload.product,
          inline: true
        },
        {
          name: 'Service',
          value: payload.service,
          inline: true
        },
        {
          name: 'Environment',
          value: payload.environment,
          inline: true
        }
      ],
      timestamp: payload.timestamp,
      footer: {
        text: 'Heimdizzy Deployment Tool'
      }
    }
    
    if (payload.details?.gitHash) {
      embed.fields.push({
        name: 'Git Hash',
        value: `\`${payload.details.gitHash}\``,
        inline: true
      })
    }
    
    if (payload.details?.duration) {
      embed.fields.push({
        name: 'Duration',
        value: `${Math.round(payload.details.duration / 1000)}s`,
        inline: true
      })
    }
    
    if (payload.details?.size) {
      embed.fields.push({
        name: 'Size',
        value: payload.details.size,
        inline: true
      })
    }
    
    if (payload.details?.artifactPath) {
      embed.fields.push({
        name: 'Artifact',
        value: `\`${payload.details.artifactPath}\``,
        inline: false
      })
    }
    
    if (payload.details?.count !== undefined) {
      embed.fields.push({
        name: 'Pod Count',
        value: payload.details.count.toString(),
        inline: true
      })
    }
    
    if (payload.details?.podStatus) {
      embed.fields.push({
        name: 'Pod Status',
        value: payload.details.podStatus,
        inline: false
      })
    }
    
    if (payload.details?.filesDeployed !== undefined) {
      embed.fields.push({
        name: 'Files Deployed',
        value: payload.details.filesDeployed.toString(),
        inline: true
      })
    }
    
    if (payload.details?.invalidationId) {
      embed.fields.push({
        name: 'CloudFront Invalidation',
        value: `\`${payload.details.invalidationId}\``,
        inline: true
      })
    }
    
    if (payload.details?.buildTime !== undefined) {
      embed.fields.push({
        name: 'Build Time',
        value: `${Math.round(payload.details.buildTime / 1000)}s`,
        inline: true
      })
    }
    
    if (payload.details?.deployTime !== undefined) {
      embed.fields.push({
        name: 'Deploy Time',
        value: `${Math.round(payload.details.deployTime / 1000)}s`,
        inline: true
      })
    }
    
    if (payload.details?.error) {
      embed.fields.push({
        name: 'Error',
        value: `\`\`\`${payload.details.error.substring(0, 1000)}\`\`\``,
        inline: false
      })
    }
    
    return embed
  }
}