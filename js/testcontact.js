/*
    SPDX-License-Identifier: Apache-2.0
*/

/**
 *
 * Created by shouhewu on 6/8/17.
 *
 */

const http = require("http")
const Test = require('./test.js')


async function startTest () {
  const server = http.createServer()
  const test = new Test()
  await test.initialize()
  server.listen(8888, function () {
    console.log('\n')
    console.log('pid is ' + process.pid)
    console.log('\n')
  })
}

startTest()
