/*
    SPDX-License-Identifier: Apache-2.0
*/

/**
 * main — EventCenter server on :8888 with the bds eos splitter HTTP contract.
 * Rewire note (sim): the server now routes /v1/chain/* POSTs into the center
 * (pegaton/splitter/eos/handler_http.go client shape); web3 relayer polling
 * starts in EventCenter.initialize().
 */

const http = require('http')
const EventCenter = require('./EventCenter.js')

process.on('unhandledRejection', err => {
  console.error('UNHANDLED_REJECTION:', (err && err.stack) || String(err))
})
process.on('uncaughtException', err => {
  console.error('UNCAUGHT:', (err && err.stack) || String(err))
})
process.on('exit', code => console.error('PROCESS_EXIT code=' + code))
process.on('SIGTERM', () => { console.error('SIGTERM_GOT'); process.exit(0) })
process.on('SIGINT', () => { console.error('SIGINT_GOT'); process.exit(0) })

async function startListen () {
  const server = http.createServer()
  const eventCenter = new EventCenter()
  await eventCenter.initialize()
  server.on('request', (req, res) => eventCenter.handleChainRequest(req, res))
  server.listen(8888, function () {
    console.log('\n')
    console.log('pid is ' + process.pid)
    console.log('\n')
  })
}

startListen()