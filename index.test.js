/// <reference path="types.js" />

import test from 'node:test'
import assert from 'node:assert/strict'
import { sep } from 'path'
import fs from 'fs/promises'

import log from 'loglevel'
import { globSync } from 'glob'
import StreamZip from 'node-stream-zip'
import * as dotenv from 'dotenv'

import { WACZ } from './index.js'
import { FIXTURES_PATH } from './constants.js'
import { assertSHA256WithPrefix, assertValidWACZSignatureFormat } from './utils/assertions.js' // see https://github.com/motdotla/dotenv#how-do-i-use-dotenv-with-import

// Loads env vars from .env if provided
dotenv.config()

/**
 * Path to *.warc.gz files in the fixture folder.
 * @constant
 */
const FIXTURE_INPUT = `${FIXTURES_PATH}${sep}*.warc.gz`

test('WACZ constructor throws if options.log is provided but not Console-API compatible.', async (_t) => {
  const scenarios = [true, 'foo', {}, Buffer.alloc(0), 12, () => {}]

  for (const log of scenarios) {
    assert.throws(() => new WACZ({ input: FIXTURE_INPUT, log }))
  }
})

test('WACZ constructor accepts a Console-API compatible object for options.log.', async (_t) => {
  const archive = new WACZ({ input: FIXTURE_INPUT, log })
  assert.equal(archive.log, log)
})

test('WACZ constructor throws if options.input is absent or invalid.', async (_t) => {
  const scenarios = [null, true, 'foo', {}, Buffer.alloc(0), 12, () => {}, './']

  for (const input of scenarios) {
    assert.throws(() => new WACZ({ input }))
  }
})

test('WACZ constructor accepts options.input if it is either a string or array.', async (_t) => {
  const scenarios = [FIXTURE_INPUT, [FIXTURE_INPUT]]

  for (const input of scenarios) {
    assert.doesNotThrow(() => new WACZ({ input }))
  }
})

test('WACZ constructor throws if options.output is invalid.', async (_t) => {
  const scenarios = ['foo', true, {}, Buffer.alloc(0), 12, () => {}, './', 'test.zip']

  for (const output of scenarios) {
    assert.throws(() => new WACZ({ input: FIXTURE_INPUT, output }))
  }
})

test('WACZ constructor ignores options.detectPages if invalid.', async (_t) => {
  const scenarios = ['foo', {}, Buffer.alloc(0), 12, () => {}]

  for (const detectPages of scenarios) {
    const archive = new WACZ({ input: FIXTURE_INPUT, detectPages })
    assert.equal(archive.detectPages, true)
  }
})

test('WACZ constructor accounts for options.detectPages if valid.', async (_t) => {
  const archive = new WACZ({ input: FIXTURE_INPUT, detectPages: false })
  assert.equal(archive.detectPages, false)
})

test('WACZ constructor ignores options.url if invalid.', async (_t) => {
  const scenarios = ['foo', {}, Buffer.alloc(0), 12, () => {}]

  for (const url of scenarios) {
    const archive = new WACZ({ input: FIXTURE_INPUT, url })
    assert.equal(archive.url, null)
  }
})

test('WACZ constructor accounts for options.url if valid.', async (_t) => {
  const url = 'https://lil.law.harvard.edu'
  const archive = new WACZ({ input: FIXTURE_INPUT, url })
  assert.equal(archive.url, url)
})

test('WACZ constructor ignores options.ts if invalid.', async (_t) => {
  const scenarios = ['YESTERDAY', 'foo', () => {}]

  for (const ts of scenarios) {
    const archive = new WACZ({ input: FIXTURE_INPUT })
    const defaultTs = archive.ts
    archive.filterNonBlockingOptions({ ts })
    assert.equal(archive.ts, defaultTs)
  }
})

test('WACZ constructor accounts for options.ts if valid.', async (_t) => {
  const ts = new Date().toISOString()
  const archive = new WACZ({ input: FIXTURE_INPUT, ts })
  assert.equal(archive.ts, ts)
})

test('WACZ constructor accounts for options.title if provided.', async (_t) => {
  const archive = new WACZ({ input: FIXTURE_INPUT, title: 'FOO' })
  assert.equal(archive.title, 'FOO')
})

test('WACZ constructor accounts for options.description if provided.', async (_t) => {
  const archive = new WACZ({ input: FIXTURE_INPUT, description: 'FOO' })
  assert.equal(archive.description, 'FOO')
})

test('WACZ constructor ignores options.signingUrl if invalid.', async (_t) => {
  const scenarios = ['foo', {}, Buffer.alloc(0), 12, () => {}]

  for (const signingUrl of scenarios) {
    const archive = new WACZ({ input: FIXTURE_INPUT, signingUrl })
    assert.equal(archive.signingUrl, null)
  }
})

test('WACZ constructor accounts for options.signingUrl if valid.', async (_t) => {
  const signingUrl = 'https://lil.law.harvard.edu'
  const archive = new WACZ({ input: FIXTURE_INPUT, signingUrl })
  assert.equal(archive.signingUrl, signingUrl)
})

test('WACZ constructor ignores options.signingUrl if invalid.', async (_t) => {
  const scenarios = ['foo', {}, Buffer.alloc(0), 12, () => {}]

  for (const signingUrl of scenarios) {
    const archive = new WACZ({ input: FIXTURE_INPUT, signingUrl })
    assert.equal(archive.signingUrl, null)
  }
})

test('WACZ constructor accounts for options.signingToken if provided alongside options.signingUrl.', async (_t) => {
  const scenarios = [
    { signingUrl: 'https://lil.law.harvard.edu', signingToken: 'FOO', shouldHaveToken: true },
    { signingUrl: null, signingToken: 'FOO', shouldHaveToken: false }
  ]

  for (const scenario of scenarios) {
    const archive = new WACZ({
      input: FIXTURE_INPUT,
      signingUrl: scenario.signingUrl,
      signingToken: scenario.signingToken
    })

    if (scenario.shouldHaveToken) {
      assert.equal(archive.signingToken, scenario.signingToken)
    } else {
      assert.equal(archive.signingToken, null)
    }
  }
})

test('WACZ constructor accounts for options.datapackageExtras if provided.', async (_t) => {
  const datapackageExtras = { foo: 'bar' }
  const archive = new WACZ({ input: FIXTURE_INPUT, datapackageExtras })
  assert.equal(archive.datapackageExtras, datapackageExtras)
})

test('addPage adds entry to pagesTree and turns detectPages off.', async (_t) => {
  const archive = new WACZ({ input: FIXTURE_INPUT })
  assert.equal(archive.detectPages, true)
  assert.equal(archive.pagesTree.length, 0)

  archive.addPage('https://lil.law.harvard.edu', 'LIL')

  assert.equal(archive.detectPages, false)
  assert.equal(archive.pagesTree.length, 1)
})

// Note: if `TEST_SIGNING_URL` / `TEST_SIGNING_TOKEN` are present, this will also test the signing feature.
test('WACZ.process runs the entire process and writes a valid .wacz to disk, accounting for options.', async (_t) => {
  //
  // Preparation step: create WACZ out of .warc.gz files in "fixtures" folder.
  //
  const options = {
    input: FIXTURE_INPUT,
    output: '../tmp.wacz',
    url: 'https://lil.law.harvard.edu',
    title: 'WACZ Title',
    description: 'WACZ Description',
    ts: '2023-02-22T12:00:00Z',
    datapackageExtras: { context: 'Testing' },
    signingUrl: process.env?.TEST_SIGNING_URL,
    signingToken: process.env?.TEST_SIGNING_TOKEN
  }

  const archive = new WACZ(options)

  // Test adding extra files
  await archive.addFileToZip(
    Buffer.from('HELLO WORLD'),
    'hello.txt'
  )

  await archive.process(false)

  //
  // Load up resulting WACZ to check that everything worked
  //
  const zip = new StreamZip.async({ file: options.output }) // eslint-disable-line
  const zipEntries = await zip.entries()

  //
  // Indexes should be present
  //
  // NOTE: A test for the ZipNum Shared Index feature would require additional / larger fixtures.
  assert(await zip.entryData('indexes/index.cdx'))

  //
  // `hello.txt` should be present
  //
  assert(await zip.entryData('hello.txt'))

  //
  // There should be as many .warc.gz files as there are in the fixtures folder.
  //
  let warcCount = 0

  for (const entry of Object.values(zipEntries)) {
    if (entry.name.endsWith('.warc.gz')) {
      warcCount += 1

      // Loosely check that it is indeed a .warc.gz
      const data = await zip.entryData(entry.name)
      assert.equal(data[0], 0x1f)
      assert.equal(data[1], 0x8b)
    }
  }

  assert.equal(warcCount, globSync(FIXTURE_INPUT).length)

  //
  // datapackage.json should be present, valid, and hold the data we passed to it.
  //
  const datapackage = JSON.parse(await zip.entryData('datapackage.json'))

  assert.equal(datapackage.title, options.title)
  assert.equal(datapackage.profile, 'data-package')
  assert.equal(datapackage.description, options.description)
  assert.equal(datapackage.mainPageUrl, options.url)
  assert.equal(datapackage.mainPageDate, new Date(options.ts).toISOString())
  assert.deepEqual(datapackage.extras, options.datapackageExtras)

  assert.deepEqual(
    datapackage.resources,
    archive.resources.filter(entry => entry.name !== 'datapackage.json')
  )

  //
  // datapackage-digest.json should be present and valid
  //
  const datapackageDigest = JSON.parse(await zip.entryData('datapackage-digest.json'))

  assert(datapackageDigest.hash)
  assert.doesNotThrow(() => assertSHA256WithPrefix(datapackageDigest.hash))
  assert(datapackageDigest.path, 'datapackage.json')

  // Extra: if `TEST_SIGNING_URL` was provided, check signature
  if (process.env?.TEST_SIGNING_URL) {
    assert.doesNotThrow(() => assertValidWACZSignatureFormat(datapackageDigest.signedData))
  }

  //
  // All lines in pages.jsonl should be valid JSON in the format we expect.
  //
  const pagesJSONL = (await zip.entryData('pages/pages.jsonl')).toString('utf-8')
  let pagesCount = 0

  for (const entry of pagesJSONL.split('\n')) {
    if (!entry.startsWith('{')) {
      continue
    }

    const page = JSON.parse(entry)

    // First line
    if (page?.format) {
      assert.equal(page.format, 'json-pages-1.0')
      assert(page.id)
      assert(page.title)
      continue
    }

    // All other lines
    assert(page.url)
    assert(page.id)

    if (page?.ts) {
      assert.doesNotThrow(() => new Date(page.ts))
    }

    pagesCount += 1
  }

  assert.notEqual(pagesCount, 0)

  // Delete temp file
  await fs.unlink(options.output)
})
