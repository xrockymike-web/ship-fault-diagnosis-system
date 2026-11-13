import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { resolve } from 'node:path'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'

/**
 * 落点契约（D2-28 统一布局；《阶段1开发过程》§4 的落点已按此更新）——**开发态与交付态同一形状**：
 *   workspace/query/bin/                                     ← 程序树 ↔ 交付态 portable/bin/
 *   ├─ package.json  { main: 'main.js' }（构建生成，不带 type: module）
 *   ├─ main.js       主进程   （Rollup 单入口，CJS）
 *   ├─ preload.js    preload  （同上，CJS）
 *   ├─ frontend/     渲染进程产物（Vite 构建，base './'，file:// 加载）
 *   ├─ config/       默认配置（**原样复制**，不编译）
 *   ├─ qa-core/index.js  launcher/bootstrap/index.js   （多入口 + preserveModules，CJS）
 *   ├─ shared/ text-retrieval/ …（占位 README，逐目录对应源码树）
 *   └─ bin/                                                  ← Electron 运行时 ↔ portable/bin/bin/
 *      ├─ 船舶故障诊断系统.exe（electron.exe 改名）+ *.dll/*.pak/locales/
 *      └─ resources/app/    ← **只有两行跳板**：main: loader.js → require('../../../main.js')
 *
 * 五条硬约束（2026-09-27 实测，证据：交接文档/验收记录/阶段1.2/）
 *   1. sandbox: true 下 preload 必须是 CJS，否则 window.shipApp 不注入
 *      （02-preload-probe.md）；CJS 由「package.json 不带 type: module」保证（D-1.2-2）。
 *   2. 插件选项键名是 vite，不是 config —— 写错会被静默忽略（旧配置的 config:{} 就是这样丢的）。
 *   3. dev 态 Electron 的 app 目录必须直接指到 <bin>/resources/app，
 *      不能传 <bin>（02b-error-app-dir-trap.png）。
 *   4. base 必须「构建态 './'、开发态 '/'」：构建态给 file:// 用要相对路径；
 *      开发态插件用 `端口 + base` 拼 dev URL，写 './' 会拼出非法 URL。
 *   5. 后端模块必须 preserveModules，目录结构才与源码同构（S5 契约）。
 */
/** 产品版本号的**唯一源**（D2-17）：frontend/package.json —— 别的产物都要从这里取，不许再写死 */
const APP_VERSION = (JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }).version

const QUERY_DIR = resolve(__dirname, '..')
// 🔴 布局定案（D2-31「乙」，2026-09-27 负责人决定并冻结）
//   源码区  workspace/query/                    → 10 个模块目录（纯源码）
//           workspace/bin/                      → Electron 运行时 + 入口 exe
//           workspace/bin/resources/app/        → 构建产物（程序树；开发态直接跑，不需要跳板）
//   交付态  portable/query/                     → 程序树（与源码区 10 个目录同名对应）
//           portable/bin/                       → Electron 运行时 + 入口 exe + resources/app（两行跳板）
//   两区顶层同构：query/ bin/ data/ environment/
const BIN_RUNTIME = resolve(QUERY_DIR, '..', 'bin')           // workspace/bin = 运行时 + 入口 exe（D2-31 乙方案）
const BIN_APP = resolve(BIN_RUNTIME, 'resources', 'app')      // 构建产物落点 = Electron 的 app 目录
const BIN_PROGRAM = BIN_APP                                   // 别名：程序树（编译产物）
/** 已冻结但**尚未实现**的模块（只有 .gitkeep）—— 产物里给它们放占位说明，保证两区同构 */
const PLACEHOLDER_MODULES = ['text-retrieval', 'graph-retrieval', 'answer-generation']

/** 后端模块入口：新增模块时在此登记（模块清单本身已冻结，不得增删目录） */
const BACKEND_ENTRIES: Record<string, string> = {
  'qa-core/index': resolve(QUERY_DIR, 'qa-core/index.ts'),
  // 目标 2.5：embed() / rerank() 薄封装（目标 3 建库与目标 4 检索要用，冒烟命令也 require 它）
  'answer-generation/index': resolve(QUERY_DIR, 'answer-generation/index.ts'),
  'launcher/bootstrap/index': resolve(QUERY_DIR, 'launcher/bootstrap/index.ts'),
  'launcher/process-manager/index': resolve(QUERY_DIR, 'launcher/process-manager/index.ts'),
  'launcher/health-check/index': resolve(QUERY_DIR, 'launcher/health-check/index.ts'),
  'launcher/diagnostics/index': resolve(QUERY_DIR, 'launcher/diagnostics/index.ts'),
}

/**
 * 空目录会被 ZIP 丢掉（Compress-Archive 不写空目录项），而"交付树要与源码树逐目录一致"是硬要求（D2-28）。
 * 所以给每个空目录补一份一行说明；`bin/` 子树是 Electron 运行时，不碰。
 */
function ensureNoEmptyDirs(root: string, skipTop = ['bin']): void {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    if (skipTop.includes(e.name)) continue
    const dir = resolve(root, e.name)
    const children = readdirSync(dir)
    if (children.length === 0) {
      writeFileSync(resolve(dir, 'README.md'),
        '# ' + e.name + ' —— 目录占位\n\n' +
          '本目录当前没有内容（源码区也还是空的）。留一份说明是为了**交付树与源码树逐目录一致**\n' +
          '（《技术路线总纲》§7.1.1「两区同构」，D2-28）—— 空目录进不了 ZIP，会被打包工具丢掉。\n')
      continue
    }
    ensureNoEmptyDirs(dir, [])
  }
}

/** dev 与 build 都要产出：app 清单 + config 原样复制（configResolved 两种模式各触发一次） */
function syncAppShell(): void {
  mkdirSync(BIN_PROGRAM, { recursive: true })
  writeFileSync(
    resolve(BIN_PROGRAM, 'package.json'),
    JSON.stringify({ name: 'ship-diagnosis', version: APP_VERSION, main: 'main.js' }, null, 2) + '\n',
  )
  // .gitkeep 只是源码侧的占位标记，不该进产物
  cpSync(resolve(QUERY_DIR, 'config'), resolve(BIN_PROGRAM, 'config'), {
    recursive: true,
    filter: (src) => !src.endsWith('.gitkeep'),
  })
  // 目标 2.4：启动器资源（图标 / 无卡说明 / 启动错误页）与 config/ 一样**原样复制**，
  // 所以「改文案不需要重新构建」（P14）。读取方见施工单 §4.6。
  cpSync(resolve(QUERY_DIR, 'launcher', 'resources'), resolve(BIN_PROGRAM, 'launcher', 'resources'), {
    recursive: true,
    filter: (src) => !src.endsWith('.gitkeep'),
  })

  // 两区同构（总纲 §7.1.1）：**还没实现的模块也要在产物里占位**，否则源码树与产物树对不上
  // （2026-09-27 审核发现：portable/bin/README.md 声称「6 个业务模块目录都保留」，实际只有已实现的那几个）。
  // 用一份 README.md 而不是空目录 —— **空目录进不了 ZIP**（Compress-Archive 会跳过），只有文件留得住。
  // `shared/` 与那 4 个模块不同：它是**编译期契约**，永远不会产出自己的 index.js（被内联进各模块）。
  // 但交付树要与源码树逐目录对应（D2-28，负责人要求 11 个目录一个不少），所以也放一份**永久**说明。
  const sharedDir = resolve(BIN_PROGRAM, 'shared')
  mkdirSync(sharedDir, { recursive: true })
  // shared/ 是**编译期契约**（只该有 README）：历史构建若留下过运行时文件，一并清掉
  for (const stale of ['types.js', 'index.js']) {
    const p = resolve(sharedDir, stale)
    if (existsSync(p)) rmSync(p)
  }
  writeFileSync(
    resolve(sharedDir, 'README.md'),
    '# shared —— 类型契约 + 双档逻辑（本目录没有 index.js）\n\n' +
      '源码区 workspace/query/shared/ 放两类东西：\n' +
      '  · `types.ts` —— **纯类型**，构建时被**内联**进各模块产物，运行时没有对应的 .js；\n' +
      '  · `dial.ts` —— 🆕 v0.3.2 起**双档（GPU / CPU）分档逻辑的单一出处**。它是**真运行时模块**：\n' +
      '    主进程与后端（qa-core / process-manager）都要用它，所以本目录会出现 `dial.js`，\n' +
      '    由 preserveModules 原样产出、被各模块以相对路径 require（**单一副本**，不是内联）。\n\n' +
      '为什么还要有这个目录：交付树要与源码树逐目录对应（《技术路线总纲》§7.1.1「两区同构」，D2-28），\n' +
      '目的是「某个功能对应哪个文件」始终可追溯 —— 看到本目录就知道该去源码区哪里找契约定义。\n',
  )

  // ⚠️ **空目录进不了 ZIP**（Compress-Archive 会跳过）—— 2026-09-27 实测：`config/{evidence,logging,retrieval}`
  //    是空的，打包后它们就消失了，解压出来的树与源码树对不上。所以给每个空目录补一行说明。
  ensureNoEmptyDirs(BIN_PROGRAM)

  for (const m of PLACEHOLDER_MODULES) {
    if (existsSync(resolve(QUERY_DIR, m, 'index.ts'))) {
      // 已实现：构建会产出 index.js。🔴 **顺手清掉历史构建留下的占位说明** ——
      // 否则「尚未实现」的 README 会跟着产物进包（本轮 4.5 实现 text/graph 时踩到）。
      const stale = resolve(BIN_PROGRAM, m, 'README.md')
      if (existsSync(stale)) rmSync(stale)
      continue
    }
    const dir = resolve(BIN_PROGRAM, m)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      resolve(dir, 'README.md'),
      '# ' + m + ' —— 尚未实现\n\n' +
        '本目录是**占位**：源码区 workspace/query/' + m + '/ 目前只有 .gitkeep，所以这里没有 index.js。\n' +
        '实现后（目标 4/5）本目录会出现 index.js，这份说明会被自动移除。\n\n' +
        '为什么要有这个文件：产物树要与源码树一一对应（《技术路线总纲》§7.1.1「两区同构」），\n' +
        '而**空目录进不了 ZIP**，所以用一份说明文件占位。\n',
    )
  }
}

const appShellPlugin = () => ({
  name: 'gen-app-shell',
  configResolved() {
    syncAppShell()
  },
})

/** 主进程 / preload 共用（每次返回新对象，避免被插件就地改写） */
const nodeSideBuild = () => ({
  outDir: BIN_PROGRAM,
  emptyOutDir: false, // 不能清空：同级还有 frontend/ config/ qa-core/ …
  rollupOptions: { output: { entryFileNames: '[name].js' } },
})

/**
 * 主进程产物里，后端模块必须保持**相对 require**、不能内联 —— 否则 bootstrap 会出现两份实例。
 * 但源码侧（frontend/electron/）与产物侧（resources/app/）的相对布局不同，所以分两步：
 *   external —— 阻止 Rollup 解析并打包这些模块；
 *   paths    —— 把 import 说明符改写成产物侧的相对路径。
 */
// ⚠️ 必须**逐个精确映射**：早期版本用 id.includes('launcher') 做子串判断，
//    结果 ../../launcher/process-manager/index 也被改写成 bootstrap 的路径 ——
//    main.js 里两个不同模块 require 到同一个文件，运行时报
//    "loadModelsConfig is not a function"（构建期完全不报）。
//    另一个坑：external 收到的是**原始说明符**（'../../launcher/bootstrap/index'），
//    而 paths 收到的是**已解析的绝对 id**（'<盘符>:/…/query/launcher/bootstrap/index.ts'）。
//    只按前缀匹配会导致 paths 匹配失败 → 产物里写出 "./<盘符>:/…" 这种开发机绝对路径
//    （判据 3 直接不过，且完全不可搬移）。所以统一用"模块 key"匹配两种形态。
const BACKEND_MODULES: Array<{ key: string; to: string }> = [
  { key: 'qa-core', to: './qa-core/index.js' },
  { key: 'launcher/bootstrap', to: './launcher/bootstrap/index.js' },
  { key: 'launcher/process-manager', to: './launcher/process-manager/index.js' },
  { key: 'launcher/health-check', to: './launcher/health-check/index.js' },
  { key: 'launcher/diagnostics', to: './launcher/diagnostics/index.js' },
]

const matchBackend = (id: string) => {
  const norm = id.replace(/\\/g, '/')
  return BACKEND_MODULES.find((m) => norm.includes('/' + m.key + '/') || norm.endsWith('/' + m.key))
}

const BACKEND_EXTERNALS = (id: string): boolean => matchBackend(id) !== undefined

const backendPaths = (id: string): string => matchBackend(id)?.to ?? id

/** dev 态启动 Electron：直接把 app 目录指到 <bin>/resources/app（见约束 3） */
const startApp = (args: { startup: (argv?: string[], options?: object, customElectronPkg?: string) => Promise<void> }) => {
  void args.startup([BIN_APP, '--no-sandbox'])
}

export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/', // 见约束 4
  plugins: [
    react(),
    appShellPlugin(),
    electron([
      {
        // ① 主进程 → resources/app/main.js（CJS）
        entry: 'electron/main.ts',
        onstart: startApp,
        vite: {
          build: {
            ...nodeSideBuild(),
            rollupOptions: {
              external: BACKEND_EXTERNALS,
              output: { entryFileNames: '[name].js', paths: backendPaths },
            },
          },
        },
      },
      {
        // ② preload → resources/app/preload.js（CJS）
        //    preload 改动必须重启 Electron（它按窗口加载，热重载刷新不够）
        entry: 'electron/preload.ts',
        onstart: startApp,
        vite: { build: nodeSideBuild() },
      },
      {
        // ③ 后端模块 → resources/app/<模块>/index.js（多入口 + preserveModules，CJS）
        entry: BACKEND_ENTRIES,
        // ⚠️ 必须也挂 onstart（2026-09-27 实测踩坑，见施工单 §9 问题 10）：
        //    插件给**每个入口**各挂一个 :startup 插件，而 closeBundleCount 是共享的 ——
        //    **谁最后构建完，就由谁那一个插件实例负责启动 Electron**。只给 ①② 挂 onstart 时，
        //    若 ③ 恰好最后完成，就会走插件的默认 startup()（app 目录 = '.'），
        //    弹出 "Unable to find Electron app at <frontend>"（阶段1 问题 7 的翻版，且是竞态）。
        onstart: startApp,
        vite: {
          root: QUERY_DIR,
          build: {
            outDir: BIN_PROGRAM,
            emptyOutDir: false,
            rollupOptions: {
              output: { preserveModules: true, preserveModulesRoot: QUERY_DIR, entryFileNames: '[name].js' },
            },
          },
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  // 目标 2.3：原来的 `server.fs.allow` 是为「渲染进程 import ../config/prompts/default.json」而设；
  // 2.2 起提示词由后端读取（evidence-prompt），渲染进程不再引用 Vite root 之外的文件，**该配置已删**。
  build: {
    // ④ 渲染进程 → resources/app/frontend/
    outDir: resolve(BIN_PROGRAM, 'frontend'),
    emptyOutDir: true,
  },
}))
