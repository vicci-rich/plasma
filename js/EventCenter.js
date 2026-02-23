/**
 *    SPDX-License-Identifier: Apache-2.0
 */
const { Web3 } = require("web3")
const rootChainAbi = require('./rootChain.json')
const childChainAbi = require('./childChain.json')
const Tx = require('./Transaction.js')
const config = require('./config.json')

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
  }

  async initialize () {
        //初始化
        const web3EventRoot = new Web3(this.rootwsurl);
        const rootEvents = new web3EventRoot.eth.Contract(rootChainAbi, this.rootAdress);

        const web3EventChild = new Web3(this.childwsurl);
        const childEvents = new web3EventChild.eth.Contract(childChainAbi, this.childAdress);

        const rootWeb3 = new Web3(this.rooturl);
        const rootContract = new rootWeb3.eth.Contract(rootChainAbi, this.rootAdress);
        const rootAdmin = this.rootAdmin;
        const privateKey = this.privateKey;

        const childWeb3 = new Web3(this.childurl);
        const childContract = new childWeb3.eth.Contract(childChainAbi, this.childAdress);
        const childAdmin = this.childAdmin;

        //监听主链事件，并向子链发送存钱请求
        rootEvents.events.Deposit()
        .on("data", async (event) => {
          let data = event.returnValues;
          console.log("Deposit event:", data);
          try {
            await childContract.methods.depositChildChain(data.depositor, data.amount, data.root, data.depositBlock)
              .send({from: childAdmin, gas: 3000000});
            console.log("Deposit to child chain sent for:", childAdmin);
          } catch (err) {
            console.error("Error in depositChildChain:", err);
          }
        }).on("error", console.error);


        //监听子链事件 
        childEvents.events.CreateBlock()
        .on("data", async (event) => {
          let data = event.returnValues;
          console.log("CreateBlock event:", data);

          //获得签名
          const amount = "0x" + BigInt(data.amount).toString(16);
          console.log("amount: " + amount);
          const rawTx = {
            utxoId: data.inputId,
            utxoValue: amount, 
            newOwner: data.newOwner,
            amount: amount
           }
          const tx = new Tx(rawTx);
          const sig = tx.sign(privateKey);
          //获取 _sigs
          let sigs = "0x" + sig.r.toString('hex') + sig.s.toString('hex') + "00" ;
          if(sig.v == 28n || sig.v == 28) {
            sigs = "0x" + sig.r.toString('hex') + sig.s.toString('hex') + "01" ;
          }
          console.log("sigs: " + sigs);

          //获取 _root,  _utxoPos,_txBytes,_txHash,_signedTx,_proof,
          const sigTx = {
            utxoId: data.inputId,
            utxoValue: amount, 
            newOwner: data.newOwner,
            amount: amount,
            sigs: sigs
           }
           const sigtx = new Tx(sigTx);
           const msghash = sigtx.hash(true);
           const hash = sigtx.hash(false);
           //获取_root
           const msghashhex = "0x" + msghash.toString('hex');
           //获取_txHash
           const hashhex = "0x" + hash.toString('hex')
           console.log("msghashhex: " + msghashhex);
           console.log("hashhex: " + hashhex);
           //获取_txBytes
           const serializedTx = tx.serialize();
           const serializedTxhex = "0x" + serializedTx.toString('hex')
           console.log("serializedTxhex: " + serializedTxhex);
           //获取_signedTx
           const serializedTxsig = sigtx.serialize();
           const serializedTxsighex = "0x" + serializedTxsig.toString('hex')
           console.log("serializedTxsighex: " + serializedTxsighex);

           try {
             //调用子链添加块
             await childContract.methods.addBlock(sigs, data.blockNum, data.newOwner, data.amount, msghashhex)
               .send({from: childAdmin, gas: 3000000});

             //调用主链提交块
             await rootContract.methods.submitBlock(msghashhex)
               .send({from: rootAdmin, gas: 3000000});

             //调用主链取款
             const utxoPos = BigInt(data.blockNum) * 1000000000n;
             console.log("utxoPos: " + utxoPos.toString());
             await rootContract.methods.startExit(utxoPos, serializedTxhex, hashhex, serializedTxsighex, "0x", sigs)
               .send({from: rootAdmin, gas: 3000000});
           } catch (err) {
             console.error("Error in child event processing:", err);
           }
        }).on("error", console.error);
  }
}

module.exports = EventCenter

module.exports = EventCenter
