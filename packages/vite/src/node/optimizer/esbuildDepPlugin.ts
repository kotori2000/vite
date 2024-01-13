import path from 'node:path'
import type { ImportKind, Plugin } from 'esbuild'
import { KNOWN_ASSET_TYPES } from '../constants'
import type { PackageCache } from '../packages'
import { getDepOptimizationConfig } from '../config'
import type { ResolvedConfig } from '../config'
import {
  escapeRegex,
  flattenId,
  isBuiltin,
  isExternalUrl,
  moduleListContains,
  normalizePath,
} from '../utils'
import { browserExternalId, optionalPeerDepId } from '../plugins/resolve'
import { isCSSRequest, isModuleCSSRequest } from '../plugins/css'

const externalWithConversionNamespace =
  'vite:dep-pre-bundle:external-conversion'
const convertedExternalPrefix = 'vite-dep-pre-bundle-external:'

const cjsExternalFacadeNamespace = 'vite:cjs-external-facade'
const nonFacadePrefix = 'vite-cjs-external-facade:'

const externalTypes = [
  'css',
  // supported pre-processor types
  'less',
  'sass',
  'scss',
  'styl',
  'stylus',
  'pcss',
  'postcss',
  // wasm
  'wasm',
  // known SFC types
  'vue',
  'svelte',
  'marko',
  'astro',
  'imba',
  // JSX/TSX may be configured to be compiled differently from how esbuild
  // handles it by default, so exclude them as well
  'jsx',
  'tsx',
  ...KNOWN_ASSET_TYPES,
]

// 处理依赖打包的esbuild插件
export function esbuildDepPlugin(
  // qualified扫描出来依赖的扁平化名称和src属性的映射集合
  qualified: Record<string, string>,
  external: string[],
  config: ResolvedConfig,
  ssr: boolean,
): Plugin {
  const { extensions } = getDepOptimizationConfig(config, ssr)

  // remove optimizable extensions from `externalTypes` list
  const allExternalTypes = extensions
    ? externalTypes.filter((type) => !extensions?.includes('.' + type))
    : externalTypes

  // use separate package cache for optimizer as it caches paths around node_modules
  // and it's unlikely for the core Vite process to traverse into node_modules again
  const esmPackageCache: PackageCache = new Map()
  const cjsPackageCache: PackageCache = new Map()

  // default resolver which prefers ESM
  // createResolver是在处理config配置时调用的pluginContain的resolveId钩子
  // ESM 的路径查找函数
  const _resolve = config.createResolver({
    asSrc: false,
    scan: true,
    packageCache: esmPackageCache,
  })

  // cjs resolver that prefers Node
  // CommonJS 的路径查找函数
  const _resolveRequire = config.createResolver({
    asSrc: false,
    isRequire: true,
    scan: true,
    packageCache: cjsPackageCache,
  })

  const resolve = (
    id: string, // 当前文件
    importer: string, // 导入该文件的文件地址，绝对路径
    kind: ImportKind, // 导入类型
    resolveDir?: string,
  ): Promise<string | undefined> => {
    let _importer: string
    // explicit resolveDir - this is passed only during yarn pnp resolve for
    // entries
    if (resolveDir) {
      _importer = normalizePath(path.join(resolveDir, '*'))
    } else {
      // importer 表示导入该文件的文件
      // 如果 importer 在 qualified 中存在则设置对应文件路径，反之设置 importer
      _importer = importer in qualified ? qualified[importer] : importer
    }
    // kind为esbuild resolve钩子的第三个参数（导入方式，如 import、require）
    const resolver = kind.startsWith('require') ? _resolveRequire : _resolve
    // 根据不同模块类型返回不同的路径查找函数
    return resolver(id, _importer, undefined, ssr)
  }

  const resolveResult = (id: string, resolved: string) => {
    if (resolved.startsWith(browserExternalId)) {
      return {
        path: id,
        namespace: 'browser-external',
      }
    }
    if (resolved.startsWith(optionalPeerDepId)) {
      return {
        path: resolved,
        namespace: 'optional-peer-dep',
      }
    }
    if (ssr && isBuiltin(resolved)) {
      return
    }
    if (isExternalUrl(resolved)) {
      return {
        path: resolved,
        external: true,
      }
    }
    return {
      path: path.resolve(resolved),
    }
  }

  return {
    name: 'vite:dep-pre-bundle',
    setup(build) {
      // clear package cache when esbuild is finished
      // 清除依赖构建缓存
      build.onEnd(() => {
        esmPackageCache.clear()
        cjsPackageCache.clear()
      })

      // externalize assets and commonly known non-js file types
      // See #8459 for more details about this require-import conversion
      // 外部化静态资源和常见的非 JavaScript 文件类型
      // 有关这种 require-import 转换的更多详情，请参见 #8459
      build.onResolve(
        // 解决 #8459问题
        {
          filter: new RegExp(
            `\\.(` + allExternalTypes.join('|') + `)(\\?.*)?$`,
          ),
        },
        async ({ path: id, importer, kind }) => {
          // if the prefix exist, it is already converted to `import`, so set `external: true`
          // 如果存在前缀，则已转换为 `import`，因此设置 `external: true`.
          if (id.startsWith(convertedExternalPrefix)) {
            return {
              path: id.slice(convertedExternalPrefix.length),
              external: true,
            }
          }

          const resolved = await resolve(id, importer, kind)
          if (resolved) {
            if (kind === 'require-call') {
              // here it is not set to `external: true` to convert `require` to `import`
              return {
                path: resolved,
                namespace: externalWithConversionNamespace,
              }
            }
            return {
              path: resolved,
              external: true,
            }
          }
        },
      )
      build.onLoad(
        { filter: /./, namespace: externalWithConversionNamespace },
        (args) => {
          // import itself with prefix (this is the actual part of require-import conversion)
          // 如果存在前缀，则已转换为 `import`，因此设置 `external: true`.
          const modulePath = `"${convertedExternalPrefix}${args.path}"`
          return {
            contents:
              isCSSRequest(args.path) && !isModuleCSSRequest(args.path)
                ? `import ${modulePath};`
                : `export { default } from ${modulePath};` +
                  `export * from ${modulePath};`,
            loader: 'js',
          }
        },
      )

      function resolveEntry(id: string) {
        const flatId = flattenId(id)
        if (flatId in qualified) {
          return {
            path: qualified[flatId],
          }
        }
      }

      build.onResolve(
        { filter: /^[\w@][^:]/ },
        async ({ path: id, importer, kind }) => {
          if (moduleListContains(external, id)) {
            return {
              path: id,
              external: true,
            }
          }

          // ensure esbuild uses our resolved entries
          let entry: { path: string } | undefined
          // if this is an entry, return entry namespace resolve result
          if (!importer) {
            // 如果没有 importer 说明是入口文件
            // 调用 resolveEntry 方法，如果有返回值直接返回
            if ((entry = resolveEntry(id))) return entry
            // 入口文件可能带有别名，去掉别名之后再调用 resolveEntry 方法
            const aliased = await _resolve(id, undefined, true)
            if (aliased && (entry = resolveEntry(aliased))) {
              return entry
            }
          }

          // use vite's own resolver
          const resolved = await resolve(id, importer, kind)
          if (resolved) {
            return resolveResult(id, resolved)
          }
        },
      )

      // 插件的resolve返回browser-external，这个模块需要作为一个外部依赖处理，即它不应该被打包，而是在运行时通过 <script> 标签从 CDN 或其他地方加载。
      build.onLoad(
        { filter: /.*/, namespace: 'browser-external' },
        ({ path }) => {
          if (config.isProduction) {
            return {
              contents: 'module.exports = {}',
            }
          } else {
            return {
              // Return in CJS to intercept named imports. Use `Object.create` to
              // create the Proxy in the prototype to workaround esbuild issue. Why?
              //
              // In short, esbuild cjs->esm flow:
              // 1. Create empty object using `Object.create(Object.getPrototypeOf(module.exports))`.
              // 2. Assign props of `module.exports` to the object.
              // 3. Return object for ESM use.
              //
              // If we do `module.exports = new Proxy({}, {})`, step 1 returns empty object,
              // step 2 does nothing as there's no props for `module.exports`. The final object
              // is just an empty object.
              //
              // Creating the Proxy in the prototype satisfies step 1 immediately, which means
              // the returned object is a Proxy that we can intercept.
              //
              // Note: Skip keys that are accessed by esbuild and browser devtools.
              // 返回 CJS 以拦截命名的导入。使用 `Object.create` 来
              // 在原型中创建代理，以解决 esbuild 问题。为什么？
              //
              // 简而言之，esbuild cjs->esm 流程：
              // 1.使用 `Object.create(Object.getPrototypeOf(module.exports))` 创建空对象。
              // 2.将 `module.exports` 的道具分配给对象。
              // 3.返回对象供 ESM 使用。
              //
              // 如果我们执行 `module.exports = new Proxy({}, {})`，第 1 步将返回空对象、
              // 第 2 步什么也不做，因为 `module.exports` 没有道具。最终对象
              // 只是一个空对象。
              //
              // 在原型中创建代理立即满足了步骤 1，这意味着
              // 返回的对象是一个我们可以截取的代理。
              //
              // 注意：跳过由 esbuild 和浏览器 devtools 访问的键。
              contents: `\
module.exports = Object.create(new Proxy({}, {
  get(_, key) {
    if (
      key !== '__esModule' &&
      key !== '__proto__' &&
      key !== 'constructor' &&
      key !== 'splice'
    ) {
      console.warn(\`Module "${path}" has been externalized for browser compatibility. Cannot access "${path}.\${key}" in client code. See https://vitejs.dev/guide/troubleshooting.html#module-externalized-for-browser-compatibility for more details.\`)
    }
  }
}))`,
            }
          }
        },
      )

      build.onLoad(
        { filter: /.*/, namespace: 'optional-peer-dep' },
        ({ path }) => {
          if (config.isProduction) {
            return {
              contents: 'module.exports = {}',
            }
          } else {
            const [, peerDep, parentDep] = path.split(':')
            return {
              contents: `throw new Error(\`Could not resolve "${peerDep}" imported by "${parentDep}". Is it installed?\`)`,
            }
          }
        },
      )
    },
  }
}

const matchesEntireLine = (text: string) => `^${escapeRegex(text)}$`

// esbuild doesn't transpile `require('foo')` into `import` statements if 'foo' is externalized
// https://github.com/evanw/esbuild/issues/566#issuecomment-735551834
export function esbuildCjsExternalPlugin(
  externals: string[],
  platform: 'node' | 'browser',
): Plugin {
  return {
    name: 'cjs-external',
    setup(build) {
      const filter = new RegExp(externals.map(matchesEntireLine).join('|'))

      build.onResolve({ filter: new RegExp(`^${nonFacadePrefix}`) }, (args) => {
        return {
          path: args.path.slice(nonFacadePrefix.length),
          external: true,
        }
      })

      build.onResolve({ filter }, (args) => {
        // preserve `require` for node because it's more accurate than converting it to import
        if (args.kind === 'require-call' && platform !== 'node') {
          return {
            path: args.path,
            namespace: cjsExternalFacadeNamespace,
          }
        }

        return {
          path: args.path,
          external: true,
        }
      })

      build.onLoad(
        { filter: /.*/, namespace: cjsExternalFacadeNamespace },
        (args) => ({
          contents:
            `import * as m from ${JSON.stringify(
              nonFacadePrefix + args.path,
            )};` + `module.exports = m;`,
        }),
      )
    },
  }
}
