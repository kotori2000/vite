import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import glob from 'fast-glob'
import type {
  BuildContext,
  Loader,
  OnLoadArgs,
  OnLoadResult,
  Plugin,
} from 'esbuild'
import esbuild, { formatMessages, transform } from 'esbuild'
import colors from 'picocolors'
import type { ResolvedConfig } from '..'
import {
  CSS_LANGS_RE,
  JS_TYPES_RE,
  KNOWN_ASSET_TYPES,
  SPECIAL_QUERY_RE,
} from '../constants'
import {
  cleanUrl,
  createDebugger,
  dataUrlRE,
  externalRE,
  isInNodeModules,
  isObject,
  isOptimizable,
  moduleListContains,
  multilineCommentsRE,
  normalizePath,
  singlelineCommentsRE,
  virtualModulePrefix,
  virtualModuleRE,
} from '../utils'
import type { PluginContainer } from '../server/pluginContainer'
import { createPluginContainer } from '../server/pluginContainer'
import { transformGlobImport } from '../plugins/importMetaGlob'

type ResolveIdOptions = Parameters<PluginContainer['resolveId']>[2]

const debug = createDebugger('vite:deps')

const htmlTypesRE = /\.(html|vue|svelte|astro|imba)$/

// A simple regex to detect import sources. This is only used on
// <script lang="ts"> blocks in vue (setup only) or svelte files, since
// seemingly unused imports are dropped by esbuild when transpiling TS which
// prevents it from crawling further.
// We can't use es-module-lexer because it can't handle TS, and don't want to
// use Acorn because it's slow. Luckily this doesn't have to be bullet proof
// since even missed imports can be caught at runtime, and false positives will
// simply be ignored.
// 用于检测导入源的简单 regex。仅用于
// 或 svelte 文件中的 <script lang="ts"> 块，因为
// 因为在转译 TS 时，esbuild 会丢弃看似未使用的导入，这就
// 阻止它进一步抓取。
// 我们不能使用 es-module-lexer 因为它无法处理 TS，也不想
// 使用 Acorn，因为它很慢。幸运的是，这并不一定要做到万无一失
// 甚至可以在运行时捕捉到错误的导入。
// 会被直接忽略。

// 匹配字符串中的所有 import 语句
export const importsRE =
  /(?<!\/\/.*)(?<=^|;|\*\/)\s*import(?!\s+type)(?:[\w*{}\n\r\t, ]+from)?\s*("[^"]+"|'[^']+')\s*(?=$|;|\/\/|\/\*)/gm

export function scanImports(config: ResolvedConfig): {
  cancel: () => Promise<void>
  result: Promise<{
    deps: Record<string, string>
    missing: Record<string, string>
  }>
} {
  // Only used to scan non-ssr code

  const start = performance.now()
  const deps: Record<string, string> = {}
  const missing: Record<string, string> = {}
  let entries: string[]

  const scanContext = { cancelled: false }

  // computeEntries：拿到依赖扫描的入口文件
  const esbuildContext: Promise<BuildContext | undefined> = computeEntries(
    config,
  ).then((computedEntries) => {
    entries = computedEntries

    if (!entries.length) {
      if (!config.optimizeDeps.entries && !config.optimizeDeps.include) {
        config.logger.warn(
          colors.yellow(
            '(!) Could not auto-determine entry point from rollupOptions or html files ' +
              'and there are no explicit optimizeDeps.include patterns. ' +
              'Skipping dependency pre-bundling.',
          ),
        )
      }
      return
    }
    if (scanContext.cancelled) return

    debug?.(
      `Crawling dependencies using entries: ${entries
        .map((entry) => `\n  ${colors.dim(entry)}`)
        .join('')}`,
    )
    return prepareEsbuildScanner(config, entries, deps, missing, scanContext)
  })

  const result = esbuildContext
    .then((context) => {
      function disposeContext() {
        return context?.dispose().catch((e) => {
          config.logger.error('Failed to dispose esbuild context', { error: e })
        })
      }
      if (!context || scanContext?.cancelled) {
        disposeContext()
        return { deps: {}, missing: {} }
      }
      return context
        .rebuild()
        .then(() => {
          return {
            // Ensure a fixed order so hashes are stable and improve logs
            deps: orderedDependencies(deps),
            missing,
          }
        })
        .finally(() => {
          return disposeContext()
        })
    })
    .catch(async (e) => {
      if (e.errors && e.message.includes('The build was canceled')) {
        // esbuild logs an error when cancelling, but this is expected so
        // return an empty result instead
        return { deps: {}, missing: {} }
      }

      const prependMessage = colors.red(`\
  Failed to scan for dependencies from entries:
  ${entries.join('\n')}

  `)
      if (e.errors) {
        const msgs = await formatMessages(e.errors, {
          kind: 'error',
          color: true,
        })
        e.message = prependMessage + msgs.join('\n')
      } else {
        e.message = prependMessage + e.message
      }
      throw e
    })
    .finally(() => {
      if (debug) {
        const duration = (performance.now() - start).toFixed(2)
        const depsStr =
          Object.keys(orderedDependencies(deps))
            .sort()
            .map((id) => `\n  ${colors.cyan(id)} -> ${colors.dim(deps[id])}`)
            .join('') || colors.dim('no dependencies found')
        debug(`Scan completed in ${duration}ms: ${depsStr}`)
      }
    })

  return {
    cancel: async () => {
      scanContext.cancelled = true
      return esbuildContext.then((context) => context?.cancel())
    },
    result,
  }
}

async function computeEntries(config: ResolvedConfig) {
  let entries: string[] = []

  const explicitEntryPatterns = config.optimizeDeps.entries
  const buildInput = config.build.rollupOptions?.input

  if (explicitEntryPatterns) {
    entries = await globEntries(explicitEntryPatterns, config)
  } else if (buildInput) {
    const resolvePath = (p: string) => path.resolve(config.root, p)
    if (typeof buildInput === 'string') {
      entries = [resolvePath(buildInput)]
    } else if (Array.isArray(buildInput)) {
      entries = buildInput.map(resolvePath)
    } else if (isObject(buildInput)) {
      entries = Object.values(buildInput).map(resolvePath)
    } else {
      throw new Error('invalid rollupOptions.input value.')
    }
  } else {
    entries = await globEntries('**/*.html', config)
  }

  // Non-supported entry file types and virtual files should not be scanned for
  // dependencies.
  entries = entries.filter(
    (entry) =>
      isScannable(entry, config.optimizeDeps.extensions) &&
      fs.existsSync(entry),
  )

  return entries
}

async function prepareEsbuildScanner(
  config: ResolvedConfig,
  entries: string[],
  deps: Record<string, string>,
  missing: Record<string, string>,
  scanContext?: { cancelled: boolean },
): Promise<BuildContext | undefined> {
  const container = await createPluginContainer(config)

  if (scanContext?.cancelled) return

  const plugin = esbuildScanPlugin(config, container, deps, missing, entries)

  const { plugins = [], ...esbuildOptions } =
    config.optimizeDeps?.esbuildOptions ?? {}

  return await esbuild.context({
    absWorkingDir: process.cwd(),
    write: false,
    stdin: {
      contents: entries.map((e) => `import ${JSON.stringify(e)}`).join('\n'),
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    logLevel: 'silent',
    plugins: [...plugins, plugin],
    ...esbuildOptions,
  })
}

function orderedDependencies(deps: Record<string, string>) {
  const depsList = Object.entries(deps)
  // Ensure the same browserHash for the same set of dependencies
  depsList.sort((a, b) => a[0].localeCompare(b[0]))
  return Object.fromEntries(depsList)
}

function globEntries(pattern: string | string[], config: ResolvedConfig) {
  return glob(pattern, {
    cwd: config.root,
    ignore: [
      '**/node_modules/**',
      `**/${config.build.outDir}/**`,
      // if there aren't explicit entries, also ignore other common folders
      ...(config.optimizeDeps.entries
        ? []
        : [`**/__tests__/**`, `**/coverage/**`]),
    ],
    absolute: true,
    suppressErrors: true, // suppress EACCES errors
  })
}

export const scriptRE =
  /(<script(?:\s+[a-z_:][-\w:]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^"'<>=\s]+))?)*\s*>)(.*?)<\/script>/gis
export const commentRE = /<!--.*?-->/gs
const srcRE = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i
const typeRE = /\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i
const langRE = /\blang\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i
const contextRE = /\bcontext\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i

function esbuildScanPlugin(
  config: ResolvedConfig,
  container: PluginContainer,
  depImports: Record<string, string>,
  missing: Record<string, string>,
  entries: string[],
): Plugin {
  const seen = new Map<string, string | undefined>()

  const resolve = async (
    id: string,
    importer?: string,
    options?: ResolveIdOptions,
  ) => {
    const key = id + (importer && path.dirname(importer))
    if (seen.has(key)) {
      return seen.get(key)
    }
    const resolved = await container.resolveId(
      id,
      importer && normalizePath(importer),
      {
        ...options,
        scan: true,
      },
    )
    const res = resolved?.id
    seen.set(key, res)
    return res
  }

  const include = config.optimizeDeps?.include
  const exclude = [
    ...(config.optimizeDeps?.exclude || []),
    '@vite/client',
    '@vite/env',
  ]

  const externalUnlessEntry = ({ path }: { path: string }) => ({
    path,
    external: !entries.includes(path),
  })

  // 转换源代码中模块导入 使得 Vite 以浏览器可以理解的格式提供模块
  const doTransformGlobImport = async (
    contents: string,
    id: string,
    loader: Loader,
  ) => {
    let transpiledContents
    // transpile because `transformGlobImport` only expects js
    if (loader !== 'js') {
      transpiledContents = (await transform(contents, { loader })).code
    } else {
      transpiledContents = contents
    }

    const result = await transformGlobImport(
      transpiledContents,
      id,
      config.root,
      resolve,
    )

    return result?.s.toString() || transpiledContents
  }

  return {
    name: 'vite:dep-scan',
    setup(build) {
      const scripts: Record<string, OnLoadResult> = {}

      // external urls
      build.onResolve({ filter: externalRE }, ({ path }) => ({
        path,
        external: true,
      }))

      // data urls
      build.onResolve({ filter: dataUrlRE }, ({ path }) => ({
        path,
        external: true,
      }))

      // local scripts (`<script>` in Svelte and `<script setup>` in Vue)
      // 本地脚本（Svelte 中的 `<script>` 和 Vue 中的 `<script setup>`)
      build.onResolve({ filter: virtualModuleRE }, ({ path }) => {
        return {
          // strip prefix to get valid filesystem path so esbuild can resolve imports in the file
          // 去掉前缀以获得有效的文件系统路径，这样 esbuild 就能解析文件中的导入内容
          path: path.replace(virtualModulePrefix, ''),
          namespace: 'script',
        }
      })

      build.onLoad({ filter: /.*/, namespace: 'script' }, ({ path }) => {
        return scripts[path]
      })

      // html types: extract script contents -----------------------------------
      build.onResolve({ filter: htmlTypesRE }, async ({ path, importer }) => {
        const resolved = await resolve(path, importer)
        if (!resolved) return
        // It is possible for the scanner to scan html types in node_modules.
        // If we can optimize this html type, skip it so it's handled by the
        // bare import resolve, and recorded as optimization dep.
        // 扫描器有可能扫描 node_modules 中的 html 类型。
        // 如果我们可以优化该 html 类型，就跳过它，使其由
        // 裸导入解析处理，并记录为优化 dep。
        if (
          isInNodeModules(resolved) &&
          isOptimizable(resolved, config.optimizeDeps)
        )
          return
        return {
          path: resolved,
          namespace: 'html',
        }
      })

      const htmlTypeOnLoadCallback: (
        args: OnLoadArgs,
      ) => Promise<OnLoadResult | null | undefined> = async ({ path: p }) => {
        let raw = await fsp.readFile(p, 'utf-8')
        // Avoid matching the content of the comment
        raw = raw.replace(commentRE, '<!---->')
        const isHtml = p.endsWith('.html')
        scriptRE.lastIndex = 0
        let js = ''
        let scriptId = 0
        let match: RegExpExecArray | null
        while ((match = scriptRE.exec(raw))) {
          const [, openTag, content] = match
          const typeMatch = openTag.match(typeRE)
          const type =
            typeMatch && (typeMatch[1] || typeMatch[2] || typeMatch[3])
          const langMatch = openTag.match(langRE)
          const lang =
            langMatch && (langMatch[1] || langMatch[2] || langMatch[3])
          // skip non type module script
          if (isHtml && type !== 'module') {
            continue
          }
          // skip type="application/ld+json" and other non-JS types
          if (
            type &&
            !(
              type.includes('javascript') ||
              type.includes('ecmascript') ||
              type === 'module'
            )
          ) {
            continue
          }
          let loader: Loader = 'js'
          if (lang === 'ts' || lang === 'tsx' || lang === 'jsx') {
            loader = lang
          } else if (p.endsWith('.astro')) {
            loader = 'ts'
          }
          const srcMatch = openTag.match(srcRE)
          if (srcMatch) {
            const src = srcMatch[1] || srcMatch[2] || srcMatch[3]
            js += `import ${JSON.stringify(src)}\n`
          } else if (content.trim()) {
            // The reason why virtual modules are needed:
            // 1. There can be module scripts (`<script context="module">` in Svelte and `<script>` in Vue)
            // or local scripts (`<script>` in Svelte and `<script setup>` in Vue)
            // 2. There can be multiple module scripts in html
            // We need to handle these separately in case variable names are reused between them

            // append imports in TS to prevent esbuild from removing them
            // since they may be used in the template
            // 需要虚拟模块的原因
            // 1. 可以有模块脚本（Svelte 中的 `<script context="module">` 和 Vue 中的 `<script>`）， // 也可以有本地脚本（Svelte 中的 `<script>`和 Vue 中的 `<scriptsetup>`）。
            // 或本地脚本（Svelte 中的 `<script>` 和 Vue 中的 `<script setup>`)
            // html 中可能有多个模块脚本
            // 我们需要单独处理这些脚本，以防它们之间重复使用变量名。

            // 在 TS 中添加导入，以防止 esbuild 删除它们
            // 因为它们可能会在模板中使用
            const contents =
              content +
              (loader.startsWith('ts') ? extractImportPaths(content) : '')

            const key = `${p}?id=${scriptId++}`
            if (contents.includes('import.meta.glob')) {
              scripts[key] = {
                loader: 'js', // since it is transpiled
                contents: await doTransformGlobImport(contents, p, loader),
                resolveDir: normalizePath(path.dirname(p)),
                pluginData: {
                  htmlType: { loader },
                },
              }
            } else {
              scripts[key] = {
                loader,
                contents,
                resolveDir: normalizePath(path.dirname(p)),
                pluginData: {
                  htmlType: { loader },
                },
              }
            }

            const virtualModulePath = JSON.stringify(virtualModulePrefix + key)

            const contextMatch = openTag.match(contextRE)
            const context =
              contextMatch &&
              (contextMatch[1] || contextMatch[2] || contextMatch[3])

            // Especially for Svelte files, exports in <script context="module"> means module exports,
            // exports in <script> means component props. To avoid having two same export name from the
            // star exports, we need to ignore exports in <script>
            if (p.endsWith('.svelte') && context !== 'module') {
              js += `import ${virtualModulePath}\n`
            } else {
              js += `export * from ${virtualModulePath}\n`
            }
          }
        }

        // This will trigger incorrectly if `export default` is contained
        // anywhere in a string. Svelte and Astro files can't have
        // `export default` as code so we know if it's encountered it's a
        // false positive (e.g. contained in a string)
        // 如果字符串中的任何地方包含 `export default` 字样，此操作将错误触发。
        // 在字符串中的任何位置，此操作将错误触发。Svelte 和 Astro 文件不能将
        // `export default` 作为代码，这样我们就能知道如果遇到它是一个
        // 假阳性（例如包含在字符串中）
        if (!p.endsWith('.vue') || !js.includes('export default')) {
          js += '\nexport default {}'
        }

        return {
          loader: 'js',
          contents: js,
        }
      }

      // extract scripts inside HTML-like files and treat it as a js module
      // 提取 HTML 类文件中的脚本并将其视为 js 模块
      build.onLoad(
        { filter: htmlTypesRE, namespace: 'html' },
        htmlTypeOnLoadCallback,
      )
      // the onResolve above will use namespace=html but esbuild doesn't
      // call onResolve for glob imports and those will use namespace=file
      // https://github.com/evanw/esbuild/issues/3317
      // 上面的 onResolve 会使用 namespace=html，但 esbuild 不会这样做
      // 为 glob 导入调用 onResolve，这些导入将使用 namespace=file
      // https://github.com/evanw/esbuild/issues/3317
      build.onLoad(
        { filter: htmlTypesRE, namespace: 'file' },
        htmlTypeOnLoadCallback,
      )

      // bare imports: record and externalize ----------------------------------
      build.onResolve(
        {
          // avoid matching windows volume
          filter: /^[\w@][^:]/,
        },
        async ({ path: id, importer, pluginData }) => {
          // config中指定为exclude或者是内置了别名的模块（client || env）
          if (moduleListContains(exclude, id)) {
            return externalUnlessEntry({ path: id })
          }
          // 如果被添加到依赖扫描的列表中，直接external
          if (depImports[id]) {
            return externalUnlessEntry({ path: id })
          }
          const resolved = await resolve(id, importer, {
            custom: {
              depScan: { loader: pluginData?.htmlType?.loader },
            },
          })
          if (resolved) {
            if (shouldExternalizeDep(resolved, id)) {
              // 不是有效的文件路径或者是虚拟模块
              return externalUnlessEntry({ path: id })
            }
            // 路径解析完后有node_modules || 预构建配置中指定包含的模块
            if (isInNodeModules(resolved) || include?.includes(id)) {
              // dependency or forced included, externalize and stop crawling
              if (isOptimizable(resolved, config.optimizeDeps)) {
                depImports[id] = resolved
              }
              return externalUnlessEntry({ path: id })
              // isScannable检查给定的模块是否可以被扫描和优化（j(t)s(x)|html|vue|svelte|astro|imba等文件都可以支持扫描）
            } else if (isScannable(resolved, config.optimizeDeps.extensions)) {
              const namespace = htmlTypesRE.test(resolved) ? 'html' : undefined
              // linked package, keep crawling
              return {
                path: path.resolve(resolved),
                namespace,
              }
            } else {
              return externalUnlessEntry({ path: id })
            }
          } else {
            missing[id] = normalizePath(importer)
          }
        },
      )

      // Externalized file types -----------------------------------------------
      // these are done on raw ids using esbuild's native regex filter so it
      // should be faster than doing it in the catch-all via js
      // they are done after the bare import resolve because a package name
      // may end with these extensions

      // css
      build.onResolve({ filter: CSS_LANGS_RE }, externalUnlessEntry)

      // json & wasm
      build.onResolve({ filter: /\.(json|json5|wasm)$/ }, externalUnlessEntry)

      // known asset types
      build.onResolve(
        {
          filter: new RegExp(`\\.(${KNOWN_ASSET_TYPES.join('|')})$`),
        },
        externalUnlessEntry,
      )

      // known vite query types: ?worker, ?raw
      build.onResolve({ filter: SPECIAL_QUERY_RE }, ({ path }) => ({
        path,
        external: true,
      }))

      // catch all -------------------------------------------------------------

      build.onResolve(
        {
          filter: /.*/,
        },
        async ({ path: id, importer, pluginData }) => {
          // use vite resolver to support urls and omitted extensions
          const resolved = await resolve(id, importer, {
            custom: {
              depScan: { loader: pluginData?.htmlType?.loader },
            },
          })
          if (resolved) {
            if (
              shouldExternalizeDep(resolved, id) ||
              !isScannable(resolved, config.optimizeDeps.extensions)
            ) {
              return externalUnlessEntry({ path: id })
            }

            const namespace = htmlTypesRE.test(resolved) ? 'html' : undefined

            return {
              path: path.resolve(cleanUrl(resolved)),
              namespace,
            }
          } else {
            // resolve failed... probably unsupported type
            return externalUnlessEntry({ path: id })
          }
        },
      )

      // for jsx/tsx, we need to access the content and check for
      // presence of import.meta.glob, since it results in import relationships
      // but isn't crawled by esbuild.
      build.onLoad({ filter: JS_TYPES_RE }, async ({ path: id }) => {
        let ext = path.extname(id).slice(1)
        if (ext === 'mjs') ext = 'js'

        let contents = await fsp.readFile(id, 'utf-8')
        if (ext.endsWith('x') && config.esbuild && config.esbuild.jsxInject) {
          contents = config.esbuild.jsxInject + `\n` + contents
        }

        const loader =
          config.optimizeDeps?.esbuildOptions?.loader?.[`.${ext}`] ||
          (ext as Loader)

        if (contents.includes('import.meta.glob')) {
          return {
            loader: 'js', // since it is transpiled,
            contents: await doTransformGlobImport(contents, id, loader),
          }
        }

        return {
          loader,
          contents,
        }
      })
    },
  }
}

/**
 * when using TS + (Vue + `<script setup>`) or Svelte, imports may seem
 * unused to esbuild and dropped in the build output, which prevents
 * esbuild from crawling further.
 * the solution is to add `import 'x'` for every source to force
 * esbuild to keep crawling due to potential side effects.
 * * 当使用 TS + (Vue + `<script setup>`) 或 Svelte 时，导入可能看起来
 * 未被 esbuild 使用，并被丢弃在构建输出中，从而阻止了
 * esbuild 无法进一步抓取。
 * 解决方法是为每个源代码添加 `import 'x'`，以强制
 * 由于潜在的副作用，esbuild 会继续抓取。
 */
function extractImportPaths(code: string) {
  // empty singleline & multiline comments to avoid matching comments
  code = code
    .replace(multilineCommentsRE, '/* */')
    .replace(singlelineCommentsRE, '')

  let js = ''
  let m
  importsRE.lastIndex = 0
  while ((m = importsRE.exec(code)) != null) {
    js += `\nimport ${m[1]}`
  }
  return js
}

function shouldExternalizeDep(resolvedId: string, rawId: string): boolean {
  // not a valid file path
  // 不是有效的文件路径
  if (!path.isAbsolute(resolvedId)) {
    return true
  }
  // virtual id
  if (resolvedId === rawId || resolvedId.includes('\0')) {
    return true
  }
  return false
}

function isScannable(id: string, extensions: string[] | undefined): boolean {
  return (
    JS_TYPES_RE.test(id) ||
    htmlTypesRE.test(id) ||
    extensions?.includes(path.extname(id)) ||
    false
  )
}
