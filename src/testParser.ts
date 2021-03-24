import * as core from '@actions/core'
import * as glob from '@actions/glob'
import * as fs from 'fs'
import * as parser from 'xml-js'

export interface TestResult {
  count: number
  skipped: number
  annotations: Annotation[]
  summary: string
}

export interface Annotation {
  path: string
  start_line: number
  end_line: number
  start_column: number
  end_column: number
  annotation_level: 'failure' | 'notice' | 'warning'
  title: string
  message: string
  raw_details: string
}

export interface Position {
  fileName: string
  line: number
}

/**
 * Copyright 2020 ScaCap
 * https://github.com/ScaCap/action-surefire-report/blob/master/utils.js#L6
 *
 * Modification Copyright 2021 Mike Penz
 * https://github.com/mikepenz/action-junit-report/
 */
export async function resolveFileAndLine(
  file: string | null,
  className: string,
  output: String
): Promise<Position> {
  const fileName = file ? file : className.split('.').slice(-1)[0]
  try {
    const escapedFileName = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const matches = output.match(new RegExp(`${escapedFileName}.*?:\\d+`, 'g'))
    if (!matches) return {fileName, line: 1}

    const [lastItem] = matches.slice(-1)
    const [, line] = lastItem.split(':')
    core.debug(`Resolved file ${fileName} and line ${line}`)

    return {fileName, line: parseInt(line)}
  } catch (error) {
    core.warning(
      `⚠️ Failed to resolve file and line for ${file} and ${className}`
    )
    return {fileName, line: 1}
  }
}

/**
 * Copyright 2020 ScaCap
 * https://github.com/ScaCap/action-surefire-report/blob/master/utils.js#L18
 *
 * Modification Copyright 2021 Mike Penz
 * https://github.com/mikepenz/action-junit-report/
 */
export async function resolvePath(fileName: string): Promise<string> {
  core.debug(`Resolving path for ${fileName}`)
  const globber = await glob.create(`**/${fileName}.*`, {
    followSymbolicLinks: false
  })
  const searchPath = globber.getSearchPaths() ? globber.getSearchPaths()[0] : ''
  for await (const result of globber.globGenerator()) {
    core.debug(`Matched file: ${result}`)
    if (!result.includes('/build/')) {
      const path = result.slice(searchPath.length + 1)
      core.debug(`Resolved path: ${path}`)
      return path
    }
  }
  return fileName
}

/**
 * Copyright 2020 ScaCap
 * https://github.com/ScaCap/action-surefire-report/blob/master/utils.js#L43
 *
 * Modification Copyright 2021 Mike Penz
 * https://github.com/mikepenz/action-junit-report/
 */
export async function parseFile(
  file: string,
  suiteRegex = ''
): Promise<TestResult> {
  core.debug(`Parsing file ${file}`)

  const data: string = fs.readFileSync(file, 'utf8')
  const report = JSON.parse(parser.xml2json(data, {compact: true}))

  return parseSuite(report, '', suiteRegex)
}

async function parseSuite(
  /* eslint-disable  @typescript-eslint/no-explicit-any */
  suite: any,
  parentName: string,
  suiteRegex: string
): Promise<TestResult> {
  let count = 0
  const skipped = []
  const annotations: Annotation[] = []
  const summaryLines = []
  let totalSkipped = 0

  if (!suite.testsuite && !suite.testsuites) {
    return {count, skipped: skipped.length, annotations, summary: ''}
  }

  const testsuites = suite.testsuite
    ? Array.isArray(suite.testsuite)
      ? suite.testsuite
      : [suite.testsuite]
    : Array.isArray(suite.testsuites.testsuite)
    ? suite.testsuites.testsuite
    : [suite.testsuites.testsuite]

  for (const testsuite of testsuites) {
    if (!testsuite) {
      return {count, skipped: skipped.length, annotations, summary: ''}
    }

    const suiteName = suiteRegex
      ? parentName
        ? `${parentName}/${testsuite._attributes.name}`
        : testsuite._attributes.name.match(suiteRegex)
        ? testsuite._attributes.name
        : ''
      : ''

    const res = await parseSuite(testsuite, suiteName, suiteRegex)
    count += res.count
    totalSkipped += res.skipped
    annotations.push(...res.annotations)
    if (res.summary) {
      summaryLines.push(`### ${suiteName}\n\n${res.summary}`)
    }

    if (!testsuite.testcase) {
      continue
    }

    const testcases = Array.isArray(testsuite.testcase)
      ? testsuite.testcase
      : testsuite.testcase
      ? [testsuite.testcase]
      : []
    for (const testcase of testcases) {
      count++
      if (testcase.failure || testcase.error) {
        const stackTrace = (
          (testcase.failure && testcase.failure._cdata) ||
          (testcase.failure && testcase.failure._text) ||
          (testcase.error && testcase.error._cdata) ||
          (testcase.error && testcase.error._text) ||
          ''
        )
          .toString()
          .trim()

        const message = (
          (testcase.failure &&
            testcase.failure._attributes &&
            testcase.failure._attributes.message) ||
          (testcase.error &&
            testcase.error._attributes &&
            testcase.error._attributes.message) ||
          stackTrace.split('\n').slice(0, 2).join('\n') ||
          testcase._attributes.name
        ).trim()

        const pos = await resolveFileAndLine(
          testcase._attributes.file,
          testcase._attributes.classname
            ? testcase._attributes.classname
            : testcase._attributes.name,
          stackTrace
        )

        const stderr = testcase['system-err']

        let raw_details = stackTrace
        if (stderr) {
          raw_details += `\n\n${stderr}`
        }

        const path = await resolvePath(pos.fileName)
        const title = suiteName
          ? `${pos.fileName}.${suiteName}/${testcase._attributes.name}`
          : `${pos.fileName}.${testcase._attributes.name}`
        core.info(`${path}:${pos.line} | ${message.replace(/\n/g, ' ')}`)

        if (testcase.skipped) {
          skipped.push(title)
          totalSkipped++
        }

        summaryLines.push(`#### ${title}`, '')
        summaryLines.push('```', message, '```')

        if (stackTrace) {
          summaryLines.push(
            '',
            '<details>',
            '  <summary>Stack Trace</summary>',
            '',
            '```',
            stackTrace,
            '```',
            '</details>'
          )
        }

        if (stderr) {
          summaryLines.push(
            '',
            '<details>',
            '  <summary>Output</summary>',
            '',
            '```',
            stderr,
            '```',
            '</details>'
          )
        }

        summaryLines.push('')

        annotations.push({
          path,
          start_line: pos.line,
          end_line: pos.line,
          start_column: 0,
          end_column: 0,
          annotation_level: 'failure',
          title,
          message,
          raw_details
        })
      }
    }
  }
  if (skipped.length) {
    summaryLines.push('', '<details>', '  <summary>Output</summary>', '')
    summaryLines.push(...skipped.map(title => `${title}`))
    summaryLines.push('', '</details>')
  }
  const summary = summaryLines.join('\n')
  return {count, skipped: totalSkipped, annotations, summary}
}

/**
 * Copyright 2020 ScaCap
 * https://github.com/ScaCap/action-surefire-report/blob/master/utils.js#L113
 *
 * Modification Copyright 2021 Mike Penz
 * https://github.com/mikepenz/action-junit-report/
 */
export async function parseTestReports(
  reportPaths: string,
  suiteRegex: string
): Promise<TestResult> {
  const globber = await glob.create(reportPaths, {followSymbolicLinks: false})
  let annotations: Annotation[] = []
  let count = 0
  let skipped = 0
  const summaries = []
  for await (const file of globber.globGenerator()) {
    const {count: c, skipped: s, annotations: a, summary} = await parseFile(
      file,
      suiteRegex
    )
    if (c === 0) continue
    count += c
    skipped += s
    annotations = annotations.concat(a)
    summaries.push(summary)
  }
  return {count, skipped, annotations, summary: summaries.join('\n\n')}
}
