#!/usr/bin/env node
import { resolveMooRelease } from '../dist/vite.js'

const args = process.argv.slice(2)

function help() {
  return `Usage: moo-monitor-release [options]

Options:
  --cwd <path>           Git working directory, default: current directory
  --tag-prefix <prefix>  Only match tags with this prefix, e.g. v
  --fallback-tag <tag>   Tag name to use when no tag is found, default: untagged
  --no-latest-tag        Do not fall back to the latest local tag when describe fails
  --fetch-tags           Run git fetch <remote> --tags --force before resolving
  --remote <name>        Remote used by --fetch-tags, default: origin
  -h, --help             Show help
`
}

function readValue(name, i) {
  const value = args[i + 1]
  if (!value || value.startsWith('-')) {
    throw new Error(`${name} requires a value`)
  }

  return value
}

try {
  const opts = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-h' || arg === '--help') {
      console.log(help())
      process.exit(0)
    }
    if (arg === '--fetch-tags') {
      opts.fetchTags = true
    } else if (arg === '--no-latest-tag') {
      opts.fallbackToLatestTag = false
    } else if (arg === '--cwd') {
      opts.cwd = readValue(arg, i)
      i++
    } else if (arg === '--tag-prefix') {
      opts.tagPrefix = readValue(arg, i)
      i++
    } else if (arg === '--fallback-tag') {
      opts.fallbackTag = readValue(arg, i)
      i++
    } else if (arg === '--remote') {
      opts.remote = readValue(arg, i)
      i++
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }

  console.log(await resolveMooRelease(opts))
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e))
  console.error('Run moo-monitor-release --help for usage.')
  process.exit(1)
}
