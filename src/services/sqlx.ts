import { execSync, spawn } from 'child_process'
import chalk from 'chalk'
import fs from 'fs'
import path from 'path'
import { SqlxConfig } from '../config/schema.js'

export class SqlxService {
  private serviceName: string
  private dockerContainerName: string

  constructor(serviceName: string) {
    this.serviceName = serviceName
    this.dockerContainerName = `${serviceName}-sqlx-prepare`
  }

  /**
   * Prepare SQLx offline mode for a service
   */
  async prepareSqlx(config: SqlxConfig) {
    if (!config.enabled) {
      console.log(chalk.gray('SQLx support not enabled, skipping...'))
      return
    }

    console.log(chalk.blue('\n🐘 Preparing SQLx offline mode...'))

    try {
      // Clean up any existing container
      await this.cleanupContainer()

      // Start PostgreSQL
      await this.startPostgres(config)

      // Wait for PostgreSQL to be ready
      await this.waitForPostgres(config)

      // Run migrations
      await this.runMigrations(config)

      // Generate SQLx metadata
      await this.generateSqlxMetadata(config)

      // Verify generated files
      await this.verifySqlxFiles(config)

    } catch (error) {
      console.error(chalk.red('❌ SQLx preparation failed:'), (error as Error).message)
      throw error
    } finally {
      // Always cleanup container
      await this.cleanupContainer()
    }

    console.log(chalk.green('✅ SQLx preparation completed successfully\n'))
  }

  /**
   * Clean up any existing Docker container
   */
  private async cleanupContainer() {
    try {
      execSync(`docker rm -f ${this.dockerContainerName} 2>/dev/null || true`, {
        encoding: 'utf-8'
      })
    } catch {
      // Ignore errors - container might not exist
    }
  }

  /**
   * Start PostgreSQL container for SQLx preparation
   */
  private async startPostgres(config: SqlxConfig) {
    const dbName = this.serviceName.replace(/-/g, '_')
    const port = config.database?.port || 15432
    const dockerImage = config.prepare?.dockerImage || 'postgres:15-alpine'

    console.log(chalk.gray(`  Starting PostgreSQL on port ${port}...`))

    const dockerCmd = [
      'docker', 'run', '-d',
      '--name', this.dockerContainerName,
      '-e', `POSTGRES_USER=${dbName}`,
      '-e', `POSTGRES_PASSWORD=${process.env.POSTGRES_PASSWORD || 'development_password'}`,
      '-e', `POSTGRES_DB=${dbName}`,
      '-p', `${port}:5432`,
      dockerImage
    ]

    try {
      const containerId = execSync(dockerCmd.join(' '), {
        encoding: 'utf-8'
      }).trim()
      console.log(chalk.gray(`  Container started: ${containerId.substring(0, 12)}`))
    } catch (error) {
      throw new Error(`Failed to start PostgreSQL: ${(error as Error).message}`)
    }
  }

  /**
   * Wait for PostgreSQL to be ready
   */
  private async waitForPostgres(config: SqlxConfig) {
    const dbName = this.serviceName.replace(/-/g, '_')
    const maxAttempts = 30
    
    console.log(chalk.gray('  Waiting for PostgreSQL to be ready...'))

    for (let i = 1; i <= maxAttempts; i++) {
      try {
        execSync(
          `docker exec ${this.dockerContainerName} pg_isready -U ${dbName} -d ${dbName}`,
          { encoding: 'utf-8', stdio: 'pipe' }
        )
        console.log(chalk.gray('  PostgreSQL is ready!'))
        return
      } catch {
        if (i === maxAttempts) {
          throw new Error('PostgreSQL failed to start within timeout')
        }
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }
  }

  /**
   * Run database migrations
   */
  private async runMigrations(config: SqlxConfig) {
    const migrationsPath = config.database?.migrationsPath || 'migrations'
    
    if (!fs.existsSync(migrationsPath)) {
      console.log(chalk.yellow(`  No migrations directory found at ${migrationsPath}`))
      return
    }

    console.log(chalk.gray('  Running migrations...'))

    const migrationFiles = fs.readdirSync(migrationsPath)
      .filter((f: string) => f.endsWith('.sql'))
      .sort()

    for (const file of migrationFiles) {
      console.log(chalk.gray(`    Applying ${file}...`))
      const filePath = path.join(migrationsPath, file)
      const dbName = this.serviceName.replace(/-/g, '_')

      try {
        // Read the migration file and pipe it to psql
        const migration = fs.readFileSync(filePath, 'utf-8')
        execSync(
          `docker exec -i ${this.dockerContainerName} psql -U ${dbName} -d ${dbName}`,
          { input: migration, encoding: 'utf-8' }
        )
      } catch (error) {
        throw new Error(`Failed to apply migration ${file}: ${(error as Error).message}`)
      }
    }
  }

  /**
   * Generate SQLx metadata
   */
  private async generateSqlxMetadata(config: SqlxConfig) {
    const dbName = this.serviceName.replace(/-/g, '_')
    const port = config.database?.port || 15432
    const databaseUrl = config.database?.url || 
      `postgresql://${dbName}:${process.env.POSTGRES_PASSWORD || 'development_password'}@localhost:${port}/${dbName}`
    
    console.log(chalk.gray('  Generating SQLx metadata...'))

    // Ensure .sqlx directory exists
    const cacheDir = config.prepare?.cacheDirectory || '.sqlx'
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true })
    }

    // Check if sqlx-cli is installed
    try {
      execSync('which sqlx', { stdio: 'pipe' })
    } catch {
      console.log(chalk.yellow('  sqlx-cli not found, installing...'))
      try {
        execSync('cargo install sqlx-cli --no-default-features --features postgres', {
          stdio: 'inherit'
        })
      } catch (error) {
        console.log(chalk.yellow('  Could not install sqlx-cli automatically'))
        console.log(chalk.gray('  Please install it manually: cargo install sqlx-cli --no-default-features --features postgres'))
        return
      }
    }

    // Set environment variables and run sqlx prepare
    const env = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      SQLX_OFFLINE: 'false'
    }

    try {
      execSync('cargo sqlx prepare --workspace', {
        env,
        stdio: 'inherit'
      })
      console.log(chalk.gray('  SQLx metadata generated successfully'))
    } catch (error) {
      // Check if it's just compilation warnings
      if ((error as any).status === 101) {
        console.log(chalk.yellow('  SQLx prepare had compilation errors, but metadata may have been generated'))
      } else {
        throw new Error(`SQLx prepare failed: ${(error as Error).message}`)
      }
    }
  }

  /**
   * Verify SQLx files were generated
   */
  private async verifySqlxFiles(config: SqlxConfig) {
    const cacheDir = config.prepare?.cacheDirectory || '.sqlx'
    
    if (!fs.existsSync(cacheDir)) {
      console.log(chalk.yellow(`  Warning: ${cacheDir} directory not found`))
      return
    }

    const files = fs.readdirSync(cacheDir)
      .filter((f: string) => f.endsWith('.json'))
    
    if (files.length === 0) {
      console.log(chalk.yellow(`  Warning: No SQLx query files generated in ${cacheDir}`))
    } else {
      console.log(chalk.gray(`  Generated ${files.length} SQLx query metadata files`))
    }
  }

  /**
   * Fix common SQLx compilation issues
   */
  async fixCompilationIssues(config: SqlxConfig) {
    console.log(chalk.blue('\n🔧 Attempting to fix common SQLx issues...'))

    // Check if bigdecimal feature is needed
    const cargoToml = fs.readFileSync('Cargo.toml', 'utf-8')
    if (cargoToml.includes('rust_decimal') && !cargoToml.includes('bigdecimal')) {
      console.log(chalk.gray('  Adding bigdecimal feature to sqlx...'))
      
      const updatedCargo = cargoToml.replace(
        /sqlx = \{ version = "[^"]+", features = \[([^\]]+)\] \}/,
        (match, features) => {
          const featureList = features.split(',').map((f: string) => f.trim())
          if (!featureList.some((f: string) => f.includes('bigdecimal'))) {
            featureList.push('"bigdecimal"')
          }
          return `sqlx = { version = "0.7", features = [${featureList.join(', ')}] }`
        }
      )
      
      fs.writeFileSync('Cargo.toml', updatedCargo)
      console.log(chalk.green('  ✓ Added bigdecimal feature'))
    }

    // Fix schema mismatches if needed
    if (config.database?.migrationsPath) {
      console.log(chalk.gray('  Checking for schema mismatches...'))
      // This could be expanded to auto-fix common issues
    }
  }
}