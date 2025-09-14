import { execSync } from 'child_process'
import chalk from 'chalk'
import { Hook } from '../config/schema.js'

export class HooksService {
  /**
   * Execute a list of hooks
   */
  async executeHooks(hooks: Hook[], phase: string): Promise<void> {
    if (!hooks || hooks.length === 0) {
      return
    }

    console.log(chalk.blue(`\n🔧 Executing ${phase} hooks...`))

    for (const hook of hooks) {
      console.log(chalk.gray(`  Running: ${hook.name}`))
      if (hook.description) {
        console.log(chalk.gray(`    ${hook.description}`))
      }

      try {
        const output = execSync(hook.command, { 
          encoding: 'utf-8',
          cwd: process.cwd(),
          timeout: 300000 // 5 minutes timeout
        })
        
        if (output.trim()) {
          console.log(chalk.gray(`    Output: ${output.trim()}`))
        }
        console.log(chalk.green(`  ✅ ${hook.name} completed`))
      } catch (error: any) {
        console.error(chalk.red(`  ❌ ${hook.name} failed:`))
        console.error(chalk.red(`    ${error.message}`))
        if (error.stdout) {
          console.error(chalk.gray(`    stdout: ${error.stdout}`))
        }
        if (error.stderr) {
          console.error(chalk.gray(`    stderr: ${error.stderr}`))
        }
        throw new Error(`Hook ${hook.name} failed: ${error.message}`)
      }
    }

    console.log(chalk.green(`✅ All ${phase} hooks completed successfully\n`))
  }
}