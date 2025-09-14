import { execSync } from 'child_process'
import { mkdirSync, chmodSync } from 'fs'

// Clean and build
console.log('Building heimdizzy...')

// Clean dist directory
execSync('rm -rf dist', { stdio: 'inherit' })

// Compile TypeScript
execSync('tsc', { stdio: 'inherit' })

// Ensure bin directory exists
mkdirSync('bin', { recursive: true })

// Make the bin script executable
chmodSync('bin/heimdizzy.js', 0o755)

console.log('✓ Build complete')