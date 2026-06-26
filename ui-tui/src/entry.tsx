import React from 'react'
import { render } from 'ink'

import { App } from './app.js'
import { GatewayClient } from './gatewayClient.js'

if (!process.stdin.isTTY) {
  console.log('friday-tui: no TTY')
  process.exit(0)
}

const gateway = new GatewayClient()
gateway.start()

process.on('exit', () => gateway.kill())

render(<App gateway={gateway} />, { exitOnCtrlC: false })
