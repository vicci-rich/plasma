/**
 *    SPDX-License-Identifier: Apache-2.0
 *
 * EventCenter — plasma relayer + chain event fan-in + bds /v1/chain router.
 *
 * Sim rewire (Round-31), per pegaton/splitter/eos/handler_http.go contract:
 *  - justitia :47768 has no WS / eth_getLogs / filters → events are pulled by
 *    polling eth_blockNumber + eth_getTransactionReceipt logs.
 *  - contract sends go through raw eth_sendTransaction ({from,data,gas}); the
 *    node is legacy (no EIP-1559, no gasPrice param) — web3 is used only for
 *    ABI encode/decode.
 *  - POST /v1/chain/send_block and /send_batch_block added so that
 *    pegaton splitter eos httpHandler (bds) and the ContractEvent001-style
 *    block-verified poller can both drive this center on :8888.
 *  - tronscan feed: WS host ws.tronscan.org is dead DNS → apilist.tronscan.org
 *    REST polling with api-key from ./.api.txt and a browser UA header.
 */
const { Web3 } = require('web3')
const fs = require('fs')
const path = require('path')
const rootChainAbi = require('./rootChain.json')
const childChainAbi = require('./childChain.json')
const Tx = require('./Transaction.js')
const config = require('./config.json')

const TRONSCAN_WS = 'wss://ws.tronscan.org/socket.io/?EIO=4&transport=websocket'
const TRONSCAN_REST = 'https://apilist.tronscan.org'
const TRONSCAN_WATCH = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

class EventCenter {
  constructor () {
    this.rooturl = config['rooturl']
    this.childurl = config['childurl']
    this.rootwsurl = config['rootwsurl']
    this.childwsurl = config['childwsurl']
    this.rootAdress = config['rootAdress']
    this.childAdress = config['childAdress']
    this.privateKey = Buffer.from(config['privateKey'], 'hex')
    this.rootAdmin = config['rootAdmin']
    this.childAdmin = config['childAdmin']
    this.web3 = new Web3(new Web3.providers.HttpProvider(this.rooturl))
    this.lastPolledBlock = 0
    this.pollTimer = null
    this.tronscanTimer = null
    try {
      this.apiKey = fs.readFileSync(path.join(__dirname, '.api.txt'), 'utf8').trim()
    } catch (e) {
      this.apiKey = ''
    }
  }

  async rpc (method, params) {
    const r = await fetch(this.rooturl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 })
    })
    return r.json()
  }

  async rawSend (to, dataHex, from, gasHex) {
    const res = await this.rpc('eth_sendTransaction', [{ from: from, to: to, data: dataHex, gas: gasHex }])
    if (!res.result) {
      console.error('rawSend rpc error:', JSON.stringify(res && res.error || res).slice(0, 200))
      throw new Error('rawSend rpc error')
    }
    return res
  }

  async initialize () {
    //初始化
    const web3 = this.web3
    const rootContract = new web3.eth.Contract(rootChainAbi, this.rootAdress)
    const childContract = new web3.eth.Contract(childChainAbi, this.childAdress)
    this.rootContract = rootContract
    this.childContract = childContract
    this.rootAbi = rootChainAbi
    this.childAbi = childChainAbi

    this.topics = {
      deposit: this.web3.utils.sha3('Deposit(address,uint256,bytes32,uint256)'),
      createBlock: this.web3.utils.sha3('CreateBlock(uint256,address,uint256,bytes32)')
    }
    console.log('topics:', this.topics)

    this.lastPolledBlock = 0

    this.pollTimer = setInterval(() => {
      this.pollBlocks().catch(e => console.error('poll error:', String(e).slice(0, 200)))
    }, 1600)

    this.startTronscanFeed()
  }

  // justitia receipts return base64 for byte fields (tron-style); normalize to hex
  _normHex (v) {
    if (typeof v !== 'string') return v
    if (v.startsWith('0x')) return v
    try {
      return '0x' + Buffer.from(v, 'base64').toString('hex')
    } catch (e) {
      return v
    }
  }

  // ---------- receipt-poll puller (replaces WS/log-filter subscriptions) ----------
  async pollBlocks () {
    if (this.pollBusy) return
    this.pollBusy = true
    try {
      const cur = await this.rpc('eth_blockNumber', [])
      const latest = parseInt(cur.result || '0x0', 16)
      for (let n = this.lastPolledBlock + 1; n <= latest; n++) {
        this.lastPolledBlock = n
        const blk = await this.rpc('eth_getBlockByNumber', ['0x' + n.toString(16), true])
        if (!blk || !blk.result) continue
        const txobjs = blk.result.transactions || []
        const txs = txobjs.map(t => (t && t.hash) ? t.hash : t)
        console.log('polled block ' + n + ' txs ' + txs.length)
        for (const txh of txs) {
          const rr = await this.rpc('eth_getTransactionReceipt', [txh])
          const rcpt = rr.result
          if (!rcpt || !rcpt.logs) continue
          for (const log of rcpt.logs) {
            const addr = this._normHex(log.address)
            const topics = (log.topics || []).map(t => this._normHex(t))
            const data = this._normHex(log.data)
            if (addr === this.rootAdress && topics[0] === this.topics.deposit) {
              await this.handleRootDeposit({ address: addr, topics: topics, data: data })
            }
            if (addr === this.childAdress && topics[0] === this.topics.createBlock) {
              await this.handleChildCreateBlock({ address: addr, topics: topics, data: data })
            }
          }
        }
      }
    } finally {
      this.pollBusy = false
    }
  }

  decodeEventWith (abi, listName, log) {
    const ev = listName
    return this.web3.eth.abi.decodeLog(ev, log.data, log.topics)
  }

  async handleRootDeposit (log) {
    const ev = this.rootAbi.find(x => x.type === 'event' && x.name === 'Deposit')
    const data = this.web3.eth.abi.decodeLog(ev.inputs, log.data, log.topics)
    console.log('Deposit event:', data)
    try {
      const txEnc = this.childContract.methods.depositChildChain(data.depositor, data.amount, data.root, data.depositBlock).encodeABI()
      await this.rawSend(this.childAdress, txEnc, this.childAdmin, '0x3000000')
      console.log('Deposit to child chain sent for:', this.childAdmin)
    } catch (err) {
      console.error('Error in depositChildChain:', err)
    }
  }

  async handleChildCreateBlock (log) {
    const ev = this.childAbi.find(x => x.type === 'event' && x.name === 'CreateBlock')
    const data = this.web3.eth.abi.decodeLog(ev.inputs, log.data, log.topics)
    console.log('CreateBlock event:', data)

    //获得签名
    const amount = '0x' + BigInt(data.amount).toString(16)
    console.log('amount: ' + amount)
    const rawTx = {
      utxoId: data.inputId,
      utxoValue: amount,
      newOwner: data.newOwner,
      amount: amount
    }
    const tx = new Tx(rawTx)
    const sig = tx.sign(this.privateKey)
    //获取 _sigs
    let sigs = '0x' + sig.r.toString('hex') + sig.s.toString('hex') + '00'
    if (sig.v == 28n || sig.v == 28) {
      sigs = '0x' + sig.r.toString('hex') + sig.s.toString('hex') + '01'
    }
    console.log('sigs: ' + sigs)

    //获取 _root,  _utxoPos,_txBytes,_txHash,_signedTx,_proof,
    const sigTx = {
      utxoId: data.inputId,
      utxoValue: amount,
      newOwner: data.newOwner,
      amount: amount,
      sigs: sigs
    }
    const sigtx = new Tx(sigTx)
    const msghash = sigtx.hash(true)
    const hash = sigtx.hash(false)
    const msghashhex = '0x' + msghash.toString('hex')
    const hashhex = '0x' + hash.toString('hex')
    console.log('msghashhex: ' + msghashhex)
    console.log('hashhex: ' + hashhex)
    const serializedTx = tx.serialize()
    const serializedTxhex = '0x' + serializedTx.toString('hex')
    console.log('serializedTxhex: ' + serializedTxhex)
    const serializedTxsig = sigtx.serialize()
    const serializedTxsighex = '0x' + serializedTxsig.toString('hex')
    console.log('serializedTxsighex: ' + serializedTxsighex)

    try {
      let enc = this.childContract.methods.addBlock(sigs, data.blockNum, data.newOwner, data.amount, msghashhex).encodeABI()
      await this.rawSend(this.childAdress, enc, this.childAdmin, '0x3000000')
      console.log('addBlock sent')

      const rootSubmit = this.rootContract.methods.submitBlock(msghashhex).encodeABI()
      await this.rawSend(this.rootAdress, rootSubmit, this.rootAdmin, '0x3000000')
      console.log('Submitted block to root chain...')

      const utxoPos = BigInt(data.blockNum) * 1000000000n
      console.log('utxoPos: ' + utxoPos.toString())
      const rootExit = this.rootContract.methods.startExit(utxoPos, serializedTxhex, hashhex, serializedTxsighex, '0x', sigs).encodeABI()
      await this.rawSend(this.rootAdress, rootExit, this.rootAdmin, '0x6000000')
      console.log('Exit started.')
    } catch (err) {
      console.error('Error in child event processing:', err)
    }
  }

  // ---------- tronscan feed ----------
  async startTronscanFeed () {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      'api-key': this.apiKey || ''
    }
    // The WS host from the original design may be dead; try it once, fall back to REST.
    let wsUp = false
    try {
      const WebSocket = require('ws')
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(TRONSCAN_WS)
        const t = setTimeout(() => { ws.terminate(); reject(new Error('ws timeout')) }, 6000)
        ws.on('open', () => { clearTimeout(t); wsUp = true; ws.terminate(); resolve() })
        ws.on('error', e => { clearTimeout(t); reject(e) })
      })
    } catch (e) {
      console.log('tronscan ws feed unavailable (' + String(e.message || e).slice(0, 80) + ') → apilist REST poll')
    }
    if (wsUp) {
      console.log('tronscan ws feed UP')
      return
    }
    this.tronscanTimer = setInterval(async () => {
      try {
        const now = Date.now()
        const url = TRONSCAN_REST + '/api/contract/events?contract_address=' + TRONSCAN_WATCH +
          '&limit=3&start=0&start_timestamp=' + (now - 120000) + '&end_timestamp=' + now
        const r = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', 'api-key': this.apiKey }
        })
        const j = await r.json()
        for (const ev of (j.data || [])) {
          console.log('TRONSCAN log event:', JSON.stringify({
            contract: ev.contract_address, name: ev.event_name, block: ev.block,
            tx: ev.transaction_id, data: JSON.stringify(ev.result).slice(0, 160)
          }))
        }
      } catch (e) {
        // keep quiet after the first notice: this feed is best-effort
      }
    }, 20000)
  }

  // ---------- bds eos splitter HTTP contract (handler_http.go client) ----------
  async handleChainRequest (req, res) {
    if (req.method !== 'POST' || req.url.indexOf('/v1/chain') !== 0) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unknown endpoint' }))
      return
    }
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', async () => {
      try {
        const params = JSON.parse(body || '{}')
        if (req.url === '/v1/chain/send_block') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(await this.sendBlockRoute(params)))
        } else if (req.url === '/v1/chain/send_batch_block') {
          const out = []
          for (let n = Number(params.block_num_start); n <= Number(params.block_num_end); n++) {
            out.push(await this.sendBlockRoute({
              block_num_or_id: n,
              kafka_proxy_host: params.kafka_proxy_host,
              kafka_proxy_port: params.kafka_proxy_port,
              kafka_topic: params.kafka_topic
            }))
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ results: out }))
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'no such chain route' }))
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: String(e && e.message || e).slice(0, 200) }))
      }
    })
  }

  async sendBlockRoute (params) {
    const numOrId = params.block_num_or_id
    const topic = params.kafka_topic || 'default'
    const kHost = params.kafka_proxy_host
    const kPort = params.kafka_proxy_port
    const num = typeof numOrId === 'number' ? numOrId : parseInt(String(numOrId), 16)
    const blk = await this.rpc('eth_getBlockByNumber', ['0x' + num.toString(16), true])
    if (!blk || !blk.result) return { status: 'not_found', block_num: num }
    const eosBlock = this.mapToEosBlock(blk.result, num)
    let kafkaPushed = false
    try {
      await this.kafkaPush(topic, kHost, kPort, eosBlock)
      kafkaPushed = true
    } catch (e) {
      kafkaPushed = false
    }
    console.log('send_block routed:', num, 'txs:', eosBlock.transactions.length, 'kafka:', kafkaPushed)
    return { status: 'ok', block_num: num, kafka_pushed: kafkaPushed }
  }

  mapToEosBlock (b, num) {
    const w3 = this.web3
    const ts = new Date(parseInt(b.timestamp, 16) * 1000).toISOString().replace('Z', '')
    const strip = h => (typeof h === 'string' ? h.replace(/^0x/, '') : h)
    const idStr = strip(b.hash)
    const refPrefix = parseInt('0x' + b.mixHash.slice(-8), 16)
    return {
      timestamp: ts,
      producer: (b.miner || '').slice(0, 12),
      confirmed: 0,
      previous: strip(b.parentHash),
      transaction_mroot: strip(b.transactionsRoot || ''),
      action_mroot: strip(b.stateRoot || ''),
      schedule_version: 0,
      new_producers: null,
      header_extensions: [],
      producer_signature: '',
      block_extensions: [],
      id: idStr,
      block_num: num,
      ref_block_prefix: refPrefix,
      transactions: (b.transactions || []).map(t => ({
        status: 'executed',
        cpu_usage_us: 0,
        net_usage_words: 0,
        trx: {
          id: strip(t.hash),
          compression: 'none',
          expiration: '',
          delay_sec: 0,
          max_cpu_usage_ms: 0,
          max_net_usage_words: 0,
          packed_context_free_data: '',
          packed_trx: '',
          transaction: {
            expiration: '',
            delay_sec: 0,
            max_cpu_usage_ms: 0,
            max_net_usage_words: 0,
            packed_context_free_data: '',
            packed_trx: '',
            ref_block_num: 0,
            ref_block_prefix: 0,
            actions: [{
              account: (t.to || 'eosio.evm').slice(0, 12),
              name: t.input && t.input !== '0x' ? 'call' : 'transfer',
              authorization: [{ actor: (t.from || '').slice(0, 12), permission: 'active' }],
              data: t.input || '',
              hex_data: t.input || ''
            }]
          }
        }
      }))
    }
  }

  async kafkaPush (topic, host, port, message) {
    const url = 'http://' + host + ':' + port + '/topics/' + topic
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.kafka.json.v2+json', Accept: 'application/vnd.kafka.v2+json' },
      body: JSON.stringify({ records: [{ value: message }] })
    })
    if (!r.ok) throw new Error('kafka rest proxy status ' + r.status)
    return r.json()
  }
}

module.exports = EventCenter