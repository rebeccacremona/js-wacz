/// <reference path="types.js" />

import fs from 'fs/promises'
import { createWriteStream, createReadStream, WriteStream, unlinkSync } from 'fs' // eslint-disable-line
import { createHash } from 'crypto'
import { basename, sep } from 'path'

import { Deflate } from 'pako'
import glob from 'glob'
import BTree from 'sorted-btree'
import { Piscina } from 'piscina'
import Archiver from 'archiver'
import { v4 as uuidv4 } from 'uuid'

import { assertValidWACZSignatureFormat } from './utils/assertions.js'
import { packageInfo } from './utils/packageInfo.js'

/**
 * IDX to CDX ratio for ZipNum Shared Index.
 * For X entries in the CDX, there will be 1 in the IDX.
 * See: https://pywb.readthedocs.io/en/latest/manual/indexing.html#zipnum-sharded-index
 * @constant
 * @type {number}
 */
export const ZIP_NUM_SHARED_INDEX_LIMIT = 3000

/**
 * Utility class allowing for merging multiple .warc / .warc.gz files into a single .wacz file.
 *
 * Usage:
 * ```javascript
 * const archive = new WACZ({
 *   file: 'my-collection/*.warc.gz',
 *   output: 'my-collection.wacz'
 * })
 *
 * await archive.process() // my-collection.wacz was written to disk.
 * ```
 */
export class WACZ {
  /** @type {Console} */
  log = console

  /**
   * If `true`, enough information was provided for processing to go on.
   * @type {boolean}
   */
  ready = false

  /**
   * Worker pool for the `indexWARC` function.
   * @type {?Piscina}
   */
  indexWARCPool = null

  /**
   * From WACZOptions.file.
   * @type {?string}
   */
  file = null

  /**
   * From WACZOptions.output.
   * @type {?string}
   */
  output = null

  /**
   * From WACZOptions.detectPages.
   * @type {boolean}
   */
  detectPages = true

  /**
   * From WACZOptions.url.
   * @type {?string}
   */
  url = null

  /**
   * From WACZOptions.ts.
   * @type {?string}
   */
  ts = new Date().toISOString()

  /**
   * From WACZOptions.title.
   * @type {?string}
   */
  title = null

  /**
   * From WACZOptions.description.
   * @type {?string}
   */
  description = null

  /**
   * From WACZOptions.signingUrl.
   * @type {?string}
   */
  signingUrl = null

  /**
   * From WACZOptions.signingToken.
   * @type {?string}
   */
  signingToken = null

  /**
   * Date at which datapackage.json was generated. Needed for signing.
   * @type {?string}
   */
  datapackageDate = null

  /**
   * From WACZOptions.datapackageExtras. Stringified.
   * @type {?object}
   */
  datapackageExtras = null

  /**
   * List of files detected from path provided in `file`.
   * @type {string[]}
   */
  WARCs = []

  /**
   * B-Tree in which the key is a CDXJ string and the value is a boolean.
   * Used for "sorting on the go".
   * @type {BTree}
   */
  cdxTree = new BTree.default() // eslint-disable-line

  /** @type {string[]} */
  cdxArray = []

  /** @type {string[]} */
  idxArray = []

  /**
   * B-Tree in which the key is an url string and the value is WACZPage.
   * Used for "sorting on the go".
   * @type {BTree}
   */
  pagesTree = new BTree.default() // eslint-disable-line

  /** @type {WACZPage[]} */
  pagesArray = []

  /**
   * All files added to the zip, with the exception of datapackage-digest.json, need to be referenced here.
   * @type {WACZDatapackageResource[]}
   */
  resources = []

  /**
   * Stream to output file. To be used by `this.archive`.
   * @type {?WriteStream}
   */
  outputStream = null

  /**
   * Writeable ZIP stream.
   * @type {?Archiver}
   */
  archiveStream = null

  /**
   * @param {WACZOptions} options - See types/WACZOptions for details.
   */
  constructor (options = {}) {
    // Although non-blocking, options.log must be processed first
    if (options?.log) {
      this.log = options.log

      if (typeof this.log.trace !== 'function' ||
          typeof this.log.info !== 'function' ||
          typeof this.log.warn !== 'function' ||
          typeof this.log.error !== 'function'
      ) {
        throw new Error('"logger" must be compatible with the Console API.')
      }
    }

    this.filterBlockingOptions(options)
    this.filterNonBlockingOptions(options)
    this.ready = true

    this.initOutputStreams()
    this.initWorkerPool()
  }

  /**
   * Processes "blocking" options, which can't be skipped.
   * @param {WACZOptions} options
   * @returns {void}
   */
  filterBlockingOptions = (options) => {
    const log = this.log

    // options.file
    try {
      if (!options?.file) {
        throw new Error('`file` was not provided.')
      }

      this.file = String(options.file).trim()
      const results = glob.sync(this.file)

      for (const file of results) {
        const filename = basename(file).toLowerCase()

        if (!filename.endsWith('.warc') && !filename.endsWith('.warc.gz')) {
          this.log.trace(`${file} found ignored.`)
          continue
        }

        this.WARCs.push(file)
      }

      if (this.WARCs.length < 1) {
        throw new Error('No WARC found.')
      }
    } catch (err) {
      log.trace(err)
      throw new Error('"file" must be a valid path leading to at least 1 .warc or .warc.gz file.')
    }

    // options.output
    try {
      this.output = options?.output
        ? String(options.output).trim()
        : `${process.env.PWD}${sep}archive.wacz`

      // Path must end by `.wacz`
      if (!this.output.toLocaleLowerCase().endsWith('.wacz')) {
        throw new Error('"output" must end with .wacz.')
      }

      // Delete existing file, if any
      try {
        unlinkSync(this.output) // [!] We can't use async version here (constructor)
      } catch (_err) { }
    } catch (err) {
      log.trace(err)
      throw new Error('"output" must be a valid "*.wacz" path on which the program can write.')
    }
  }

  /**
   * Processes "non-blocking" options for which we automatically switch to defaults or skip.
   * @param {WACZOptions} options
   */
  filterNonBlockingOptions = (options) => {
    const log = this.log

    if (options?.detectPages === false) {
      this.detectPages = false
    }

    if (options?.url) {
      try {
        const url = new URL(options.url).href // will throw if invalid
        this.url = url
      } catch (_err) {
        log.warn('"url" provided is invalid. Skipping.')
      }
    }

    if (options?.ts) {
      try {
        const ts = new Date(options.ts).toISOString() // will throw if invalid
        this.ts = ts
      } catch (_err) {
        log.warn('"ts" provided is invalid. Skipping.')
      }
    }

    if (options?.title) {
      this.title = String(options.title).trim()
    }

    if (options?.description) {
      this.description = String(options.description).trim()
    }

    if (options?.signingUrl) {
      try {
        const signingUrl = new URL(options.signingUrl).href // will throw if invalid
        this.signingUrl = signingUrl
      } catch (_err) {
        log.warn('"signingUrl" provided is not a valid url. Skipping.')
      }
    }

    if (options?.signingToken && this.signingUrl) {
      this.signingToken = String(options.signingToken)
    }

    if (options?.datapackageExtras) {
      try {
        JSON.stringify(options.datapackageExtras)// will throw if invalid
        this.datapackageExtras = options.datapackageExtras
      } catch (_err) {
        log.warn('"datapackageExtras" provided is not JSON-serializable object. Skipping.')
      }
    }
  }

  /**
   * Convenience method: runs all the processing steps from start to finish.
   * @returns {Promise<void>}
   */
  process = async (verbose = true) => {
    this.readyStateCheck()

    const info = verbose ? this.log.info : () => {}

    info('Indexing WARCS.')
    await this.indexWARCs()

    info('Harvesting sorted indexes from trees.')
    this.harvestArraysFromTrees()

    info('Writing CDX to ZIP.')
    await this.writeIndexesToZip()

    info('Writing pages.jsonl to ZIP.')
    await this.writePagesToZip()

    info('Writing WARCs to ZIP.')
    await this.writeWARCsToZip()

    info('Writing datapackage.json to ZIP.')
    await this.writeDatapackageToZip()

    info('Writing datapackage-digest.json to ZIP.')
    await this.writeDatapackageDigestToZip()

    info('Finalizing ZIP.')
    this.finalize()

    info('Done.')
  }

  /**
   * Checks if `this.ready` is true, throws otherwise.
   * @returns {void}
   */
  readyStateCheck = () => {
    if (this.ready !== true) {
      throw new Error('Not enough information was provided for processing to start.')
    }
  }

  /**
   * Creates an Archiver instance which streams out to `this.output`.
   * @returns {void}
   */
  initOutputStreams = () => {
    this.readyStateCheck()

    this.outputStream = createWriteStream(this.output)
    this.archiveStream = new Archiver('zip', { store: true })
    this.archiveStream.pipe(this.outputStream)
  }

  /**
   * Initializes the worker pool for the "indexWARC" function.
   * @returns {void}
   */
  initWorkerPool = () => {
    this.readyStateCheck()

    this.indexWARCPool = new Piscina({
      filename: new URL('./workers/indexWARC.js', import.meta.url).href
    })
  }

  /**
   * Calls the 'indexWARC` worker on each entry of `this.WARCs` for parallel processing.
   * Populates `this.cdxTree` and `this.pagesTree`.
   *
   * @returns {Promise<void>} - From Promise.all.
   */
  indexWARCs = async () => {
    this.readyStateCheck()

    return await Promise.all(this.WARCs.map(async filename => {
      const results = await this.indexWARCPool.run({ filename, detectPages: this.detectPages })

      for (const value of results.cdx) {
        this.cdxTree.setIfNotPresent(value, true)
      }

      for (const value of results.pages) {
        this.pagesTree.setIfNotPresent(value.url, value)
      }
    }))
  }

  /**
   * Extract sorted CDX and pages list and clears up associated trees.
   * @returns {void}
   */
  harvestArraysFromTrees = () => {
    this.readyStateCheck()

    this.cdxArray = this.cdxTree.keysArray()
    this.cdxTree.clear()

    this.pagesArray = this.pagesTree.valuesArray()
    this.pagesTree.clear()
  }

  /**
   * Creates `index.cdx.gz` and `index.idx` out of `this.cdxArray` and writes them to ZIP.
   * @returns {Promise<void>}
   */
  writeIndexesToZip = async () => {
    this.readyStateCheck()

    const { cdxArray, idxArray, archiveStream, resources, log } = this

    let cdx = Buffer.alloc(0)
    let idxOffset = 0 // Used to for IDX metadata (IDX / CDX cross reference)

    // index.cdx.gz
    try {
      // Process CDX entries by group of ZIP_NUM_SHARED_INDEX_LIMIT for ZipNum Shared Indexing.
      for (let i = 0; i < cdxArray.length; i += ZIP_NUM_SHARED_INDEX_LIMIT) {
        let upperBound = null
        let cdxSlice = null
        let cdxSliceGzipped = null
        let idxForSlice = null
        let idxMeta = {}

        // Cut a slice in cdxArray of ZIP_NUM_SHARED_INDEX_LIMIT length
        upperBound = i + ZIP_NUM_SHARED_INDEX_LIMIT

        if (upperBound > cdxArray.length) {
          upperBound = cdxArray.length - 1
        }

        cdxSlice = cdxArray.slice(i, upperBound).join('')

        // Deflate said slice
        cdxSliceGzipped = this.gzip(cdxSlice)

        // Prepare and append the first line of this slice to `this.idxArray`
        idxForSlice = cdxArray[i]
        idxMeta = {
          offset: idxOffset,
          length: cdxSliceGzipped.byteLength,
          digest: await this.sha256(cdxSliceGzipped),
          filename: 'index.cdx.gz'
        } // The JSON part of this CDX line needs to be edited to reference the CDX file

        idxOffset += cdxSliceGzipped.byteLength

        // CDXJ elements are separated " ". We only need to replace the last and third (JSON)
        idxArray.push(`${idxForSlice.split(' ').slice(0, 1).join(' ')} ${JSON.stringify(idxMeta)}\n`)

        // Append gzipped CDX slice to the rest
        cdx = Buffer.concat([cdx, cdxSliceGzipped])
      }

      // Write index.cdx.gz to ZIP and record datapackage info
      archiveStream.append(cdx, { name: 'indexes/index.cdx.gz' })

      resources.push({
        name: 'index.cdx.gz',
        path: 'indexes/index.cdx.gz',
        hash: await this.sha256(cdx),
        bytes: cdx.byteLength
      })
    } catch (err) {
      log.trace(err)
      throw new Error('An error occurred while generating "indexes/index.cdx.gz".')
    }

    // index.idx
    try {
      // Write index.idx to ZIP and record datapackage info
      let idx = '!meta 0 {"format": "cdxj-gzip-1.0", "filename": "index.cdx.gz"}\n'

      for (const entry of idxArray) {
        idx += `${entry}`
      }

      archiveStream.append(idx, { name: 'indexes/index.idx' })

      resources.push({
        name: 'index.idx',
        path: 'indexes/index.idx',
        hash: await this.sha256(Buffer.from(idx)),
        bytes: idx.byteLength
      })
    } catch (err) {
      log.trace(err)
      throw new Error('An error occurred while generating "indexes/index.idx".')
    }
  }

  /**
   * Creates `pages.jsonl` out of `this.pagesArray` and writes it to ZIP.
   * @returns {Promise<void>}
   */
  writePagesToZip = async () => {
    this.readyStateCheck()

    const { pagesArray, archiveStream, resources, log } = this

    try {
      let pagesJSONL = '{"format": "json-pages-1.0", "id": "pages", "title": "All Pages"}\n'

      for (const page of pagesArray) {
        pagesJSONL += `${JSON.stringify(page)}\n`
      }

      archiveStream.append(pagesJSONL, { name: 'pages/pages.jsonl' })

      resources.push({
        name: 'pages.jsonl',
        path: 'pages/pages.jsonl',
        hash: await this.sha256(Buffer.from(pagesJSONL)),
        bytes: pagesJSONL.byteLength
      })
    } catch (err) {
      log.trace(err)
      throw new Error('An error occurred while generating "pages/pages.jsonl".')
    }
  }

  /**
   * Streams all the files listes in `this.WARCs` to the output ZIP.
   * @returns {Promise<void>}
   */
  writeWARCsToZip = async () => {
    this.readyStateCheck()

    const { WARCs, archiveStream, resources, log } = this

    for (const warc of WARCs) {
      try {
        const filename = basename(warc)
        const stream = createReadStream(warc)
        archiveStream.append(stream, { name: `archive/${filename}` })

        resources.push({
          name: filename,
          path: `archive/${filename}`,
          hash: await this.sha256(warc),
          bytes: (await fs.stat(warc)).size
        })
      } catch (err) {
        log.trace(err)
        throw new Error(`An error occurred while writing "${warc}" to ZIP.`)
      }
    }
  }

  /**
   * Creates `datapackage.json` out of `this.resources` and writes it to ZIP.
   * @returns {Promise<void>}
   */
  writeDatapackageToZip = async () => {
    this.readyStateCheck()

    const { archiveStream, resources, log } = this

    this.datapackageDate = new Date().toISOString()

    try {
      const datapackage = {
        created: this.datapackageDate,
        wacz_version: '1.1.1',
        software: `${packageInfo.name} ${packageInfo.version}`,
        resources
      }

      datapackage.title = this.title || 'WACZ'
      datapackage.description = this.description || ''

      if (this.url) {
        datapackage.mainPageUrl = this.url
      }

      if (this.ts) {
        datapackage.mainPageDate = this.ts
      }

      if (this.datapackageExtras) {
        datapackage.extras = this.datapackageExtras
      }

      const serializedDatapackage = JSON.stringify(datapackage, null, 2)
      const binaryDatapackage = Buffer.from(serializedDatapackage)

      archiveStream.append(serializedDatapackage, { name: 'datapackage.json' })

      resources.push({
        name: 'datapackage.json',
        path: 'datapackage.json',
        hash: await this.sha256(binaryDatapackage),
        bytes: binaryDatapackage.byteLength
      })
    } catch (err) {
      log.trace(err)
      throw new Error('An error occurred while generating "datapackage.json".')
    }
  }

  /**
   * Creates `datapackage-digest.json` and writes it to ZIP.
   * @returns {Promise<void>}
   */
  writeDatapackageDigestToZip = async () => {
    this.readyStateCheck()

    const { archiveStream, resources, log, signingUrl } = this

    try {
      const datapackageHash = (resources.find(entry => entry.name === 'datapackage.json')).hash

      const digest = {
        path: 'datapackage.json',
        hash: datapackageHash
      }

      // Request signing from server if needed
      if (signingUrl) {
        try {
          const signature = await this.requestSignature()
          digest.signedData = signature
        } catch (err) {
          log.trace(err)
          throw new Error('An error occured while signing "datapackage.json".')
        }
      }

      const datapackageDigest = JSON.stringify(digest, null, 2)

      archiveStream.append(datapackageDigest, { name: 'datapackage-digest.json' })
    } catch (err) {
      log.trace(err)
      throw new Error('An error occurred while generating "datapackage-digest.json".')
    }
  }

  /**
   * Request signature for the current datapackage and checks its format.
   * Expects the remote server to be authsign-compatible (https://github.com/webrecorder/authsign).
   * @returns {Promise<object>} - Signature to data to be appended to the datapackage digest.
   */
  requestSignature = async () => {
    this.readyStateCheck()

    const { resources, log, datapackageDate, signingUrl, signingToken } = this
    const datapackageHash = (resources.find(entry => entry.name === 'datapackage.json')).hash

    // Throw early if datapackage is not ready.
    if (!datapackageDate || !datapackageHash) {
      throw new Error('No datapackage to sign.')
    }

    /** @type {?Response} */
    let response = null

    /** @type {object} */
    let json = null

    // Request signature
    try {
      const body = JSON.stringify({
        hash: datapackageHash,
        created: datapackageDate
      })

      const headers = { 'Content-Type': 'application/json' }

      if (signingToken) {
        headers.Authorization = signingToken
      }

      response = await fetch(signingUrl, { method: 'POST', headers, body })

      if (response?.status !== 200) {
        throw new Error(`Server responded with HTTP ${response.status}.`)
      }
    } catch (err) {
      log.trace(err)
      throw new Error('WACZ Signature request failed.')
    }

    // Check signature format
    try {
      json = await response.json()
      assertValidWACZSignatureFormat(json)
    } catch (err) {
      log.trace(err)
      throw new Error('Server returned an invalid WACZ signature.')
    }

    return json
  }

  /**
   * Finalizes ZIP file
   * @returns {void}
   */
  finalize = () => {
    this.readyStateCheck()
    this.archiveStream.finalize()
  }

  /**
   * Allows to manually add an entry for pages.jsonl.
   * Entries will be added to `this.pagesTree`.
   * Calling this method automatically turns pages detection off.
   * @param {string} url - Must be a valid url
   * @param {?string} title
   * @param {?string} ts - Must be parsable by Date().
   * @returns {WACZPage}
   */
  addPage = (url, title = null, ts = null) => {
    this.readyStateCheck()
    this.detectPages = false

    /** @type {WACZPage} */
    const page = { id: uuidv4().replaceAll('-', '') }

    try {
      new URL(url) // eslint-disable-line
      page.url = url
    } catch (_err) {
      throw new Error('"url" must be a valid url.')
    }

    if (title) {
      title = String(title).trim(0)
      page.title = title
    }

    if (ts) {
      try {
        ts = new Date(ts).toISOString()
        page.ts = ts
      } catch (err) {
        throw new Error('If provided, "ts" must be parsable by JavaScript\'s Date class.')
      }
    }

    this.pagesTree.setIfNotPresent(page.url, page)
  }

  /**
   * Utility for gzipping data chunks.
   * @param {Uint8Array} chunk
   * @returns {Uint8Array}
   */
  gzip = (chunk) => {
    const output = new Deflate({ gzip: true })
    output.push(chunk, true)
    return output.result
  }

  /**
   * Computes the SHA256 hash of a given file or chunk of data.
   * @param {string|Uint8Array} file - Path to a file OR Buffer / Uint8Array.
   * @returns {Promise<string>} - "sha256:<digest>"
   */
  sha256 = async (file) => {
    // If buffer was given: directly process it.
    if (file instanceof Uint8Array) {
      return 'sha256:' + createHash('sha256').update(file).digest('hex')
    }

    // If filename was given: stream file into hash function.
    // Inspired by answers on: https://stackoverflow.com/q/18658612
    try {
      await fs.access(file)
    } catch (err) {
      this.log.trace(err)
      throw new Error(`${file} cannot be read.`)
    }

    const stream = createReadStream(file)
    const hash = createHash('sha256')
    let digest = ''

    hash.setEncoding('hex')

    await new Promise((resolve, reject) => {
      stream.on('error', err => reject(err))
      stream.on('data', chunk => hash.update(chunk))

      stream.on('end', () => {
        hash.end()
        digest = hash.read()
        resolve()
      })

      stream.pipe(hash)
    })

    return `sha256:${digest}`
  }
}
