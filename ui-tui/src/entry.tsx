#!/usr/bin/env node
import React from 'react'
import { render } from 'ink'

import { App } from './app.js'
import { HELP, VERSION, headless, parseArgs } from './cli.js'
import { GatewayClient } from './gatewayClient.js'

try {
  const options = parseArgs(process.argv.slice(2))
  if (options.command === 'help') process.stdout.write(`${HELP}\n`)
  else if (options.command === 'version') process.stdout.write(`${VERSION}\n`)
  else if (options.command !== 'tui') process.exitCode = await headless(options)
  else {
    if (!process.stdin.isTTY) throw new Error('Friday TUI needs a terminal. Use `friday run --stdin` for headless execution.')
    if (options.cwd) process.env.FRIDAY_CWD = options.cwd

    const gateway = new GatewayClient()
    gateway.start()

    process.on('exit', () => gateway.kill())

    render(<App gateway={gateway} />, { exitOnCtrlC: false })
  }
} catch (error) {
  process.stderr.write(`friday: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
