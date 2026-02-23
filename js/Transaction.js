const { Buffer } = require('buffer');
const { keccak256, ecsign, toBuffer, rlphash } = require('ethereumjs-util');
const rlp = require('rlp');

/**
 * Creates a new transaction object.
 *
 * @example
 * var rawTx = {
 *   utxoId: '0x01212',
 *   utxoValue: '0x11',
 *   newOwner: '0x2710',
 *   amount: '0x11',
 *   sigs: '0x7f7465737432000000000000000000000000000000000000000000000000000000600057'
 * };
 * var tx = new Transaction(rawTx);
 */

class Transaction {
  constructor (data) {
    data = data || {}
    this.utxoId = toBuffer(data.utxoId || Buffer.alloc(0))
    this.utxoValue = toBuffer(data.utxoValue || Buffer.alloc(0))
    this.newOwner = toBuffer(data.newOwner || Buffer.alloc(0))
    this.amount = toBuffer(data.amount || Buffer.alloc(0))
    this.sigs = toBuffer(data.sigs || Buffer.alloc(0))
  }

  get raw () {
    return [
      this.utxoId,
      this.utxoValue,
      this.newOwner,
      this.amount,
      this.sigs
    ]
  }

  /**
   * Returns the rlp encoding of the transaction
   * @method serialize
   * @return {Buffer}
   */
  serialize () {
    return Buffer.from(rlp.encode(this.raw))
  }

  /**
   * Computes a sha3-256 hash of the serialized tx
   * @param {Boolean} [includeSignature=true] whether or not to inculde the signature
   * @return {Buffer}
   */
  hash (includeSignature) {
    if (includeSignature === undefined) includeSignature = true

    let items
    if (includeSignature) {
      items = this.raw
    } else {
      items = this.raw.slice(0, 4)
    }

    // create hash
    return rlphash(items)
  }

  /**
   * sign a transaction with a given private key
   * @param {Buffer} privateKey
   */
  sign (privateKey) {
    const msgHash = this.hash(false)
    const sig = ecsign(msgHash, privateKey)
    return sig
  }
}

module.exports = Transaction
