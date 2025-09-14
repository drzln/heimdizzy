import { readFileSync, existsSync, statSync } from 'fs'
import { join, dirname } from 'path'
import yaml from 'js-yaml'
import { HeimdizzyConfigSchema, type HeimdizzyConfig } from './schema.js'

export class ConfigLoader {
  private configCache: Map<string, HeimdizzyConfig> = new Map()

  async load(searchPath?: string): Promise<HeimdizzyConfig> {
    const configPath = this.findConfigFile(searchPath)
    
    if (!configPath) {
      throw new Error('No heimdizzy.yml found. Create one in your project root.')
    }

    if (this.configCache.has(configPath)) {
      return this.configCache.get(configPath)!
    }

    let configContent = readFileSync(configPath, 'utf-8')
    
    // Replace environment variables in the format ${VAR_NAME}
    configContent = this.expandEnvironmentVariables(configContent)
    
    const rawConfig = yaml.load(configContent) as any
    
    try {
      const config = HeimdizzyConfigSchema.parse(rawConfig)
      this.configCache.set(configPath, config)
      return config
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Invalid heimdizzy.yml configuration: ${error.message}`)
      }
      throw error
    }
  }

  private findConfigFile(searchPath?: string): string | null {
    // If searchPath is a file path, use it directly
    if (searchPath && existsSync(searchPath) && !statSync(searchPath).isDirectory()) {
      return searchPath
    }
    
    const searchDirs = searchPath 
      ? [searchPath, dirname(searchPath)]
      : [process.cwd()]
    
    // Walk up directory tree looking for heimdizzy.yml
    for (let dir of searchDirs) {
      let currentDir = dir
      while (currentDir !== '/') {
        const configPath = join(currentDir, 'heimdizzy.yml')
        if (existsSync(configPath)) {
          return configPath
        }
        currentDir = dirname(currentDir)
      }
    }
    
    return null
  }

  getDeploymentConfig(config: HeimdizzyConfig, environment: string) {
    const deployment = config.deployments.find(d => d.environment === environment)
    if (!deployment) {
      throw new Error(`No deployment configuration found for environment: ${environment}`)
    }
    return deployment
  }
  
  private expandEnvironmentVariables(content: string): string {
    return content.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const value = process.env[varName]
      if (value === undefined) {
        console.warn(`Warning: Environment variable ${varName} is not set`)
        return ''
      }
      return value
    })
  }
}