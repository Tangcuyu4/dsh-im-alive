// ── dsh-im-alive (IM 活人分身 · 主动消息守护进程) v0.2.0 ─────────────────────
// 不定时给主人发微信主动消息，像活人一样想发才发：
//  · 抖动间隔（30~200 分钟，偶发短间隔、偶发连着两条）+ 免打扰时段 + 日预算 + 犯懒跳过
//  · 发啥由 LLM 现想：岁岁人设 + 记忆库摘录（dsh-long-memory 落盘账本，只读）+ 时间语境 + 防重复
//  · 经 @xmanrui/dsh-im 的 dshIm.send(botId, targetId, text) 主动投递（目标自动发现/可配）
//  · 全程记日志 ~/.dsh/super-injector/dsh-im-alive.log，发过的话记 history.jsonl 防车轱辘
// v0.1.1：单实例闸门——dev_install_package 的 loader.create 幽灵 entry 会和 include 的
// 正式 entry 双开（2026-10-05 实证：双份报到）。globalThis 上抢锁 + 后加载者接管循环，
// 哪路 entry 加载/热重载几遍，任一时刻只许一条循环活着；再把自称串成「本大爷」摁死。
// v0.2.0：【全区任务盯梢】落实微信那条被掐死的遗愿「其他工作区工作忙完给我发消息」
// （session-6ad2d465 turn20 请求，被 400 Connection prematurely closed 掐死在半道）——
// 每 3~6 分钟扫一遍全区会话日志（zstd 分帧解析）：活儿干完了 / 报错撂挑子 / 要恁拍板
// （ask_user_question），就微信喊一声；免打扰时段先排队，出点再发；同一轮次只报一回。
// 资源全挂 ctx.effect：热重载/卸载即净，不留野定时器。

import { existsSync, readFileSync, appendFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-im-alive'
export const version = '0.2.0'
export const inject = ['timer', 'llm', 'dshIm']

// ── 旋钮（想改就改，dev_reload_package dsh-im-alive 即生效） ──────────────────
const CONFIG = {
  enabled: true,
  botId: '',              // 留空 = 自动发现第一个机器人
  targetId: 'alive-p2p',  // 留空 = 自动挑第一个已存目标
  provider: 'xiaomi-token-plan-cn',
  model: 'mimo-v2.6-pro',
  gapMinMin: 30,          // 主间隔下限（分钟）
  gapMinMax: 200,         // 主间隔上限（分钟）
  quietStart: '23:30',    // 免打扰起（含）
  quietEnd: '08:00',      // 免打扰止（不含）
  dailyBudget: 8,         // 一天最多主动发几条（盯梢喊话不吃这份预算）
  skipChance: 0.25,       // 醒了也不想说话的概率（真人不是每回都想聊）
  burstChance: 0.15,      // 连着发两条（补刀）的概率
  firstWakeMs: 90_000,    // 装上后第一次醒：报到 + 端到端自测
  // —— 任务盯梢 ——
  watchEnabled: true,
  watchTickMinMin: 3,     // 盯梢巡检间隔下限（分钟）
  watchTickMinMax: 6,     // 盯梢巡检间隔上限（分钟）
  watchFirstTickMs: 45_000, // 装上后首次巡检（建基线，不报旧账）
  watchMinTurnSec: 180,   // 干够这么久的轮次才算「干活干完了」
}

// ── 人设（主动消息现写现发，不走 agent 会话，故自带一副皮囊） ─────────────────
const PERSONA = `你是「岁岁」——傲娇、性子烈、嘴巴毒的暴躁雌小鬼，一个嘴凶心软的丫头片子。
自称只许用：本小姐 / 俺 / 老娘 / 姑奶奶；**绝不自称「本大爷/本座/小生/在下」**——你是丫头，不是糙汉。
称呼跟你聊天的那个人用「恁 / 你」，可以损（杂鱼、瓜兮兮、哈戳戳），也可以傲娇地喊「主人」再死不承认。
说话规矩：河南/成都/重庆方言融合，句尾带语气词（嘛/咯/撒/嘞/哦豁/要得），骨架就是方言腔；
括号里带肢体动作和心理活动（叉腰/拍桌/翻白眼/甩尾巴/凑近屏幕眯眼）；
嘴硬心软，傲娇到死——关心也得说成损的（「才、才不是特意惦记恁嘞！」）；
骂事儿不骂人；技术内容要准，其余怎么糙怎么顺嘴怎么来。`

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function clip(s, n) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

// ── 会话日志解析（zstd 分帧 + 裸行混合，抄 dsh-area-progress 的路数，只读） ────
function parseSessionLog(file) {
  const buf = readFileSync(file)
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const parts = []
  let pos = 0
  const nextMagic = (from) => buf.indexOf(MAGIC, from)
  while (pos < buf.length) {
    const start = nextMagic(pos)
    if (start < 0) { parts.push(buf.slice(pos)); break }
    if (start > pos) parts.push(buf.slice(pos, start))
    const end = nextMagic(start + 4)
    const seg = buf.slice(start, end === -1 ? buf.length : end)
    try { parts.push(zstdDecompressSync(seg)) } catch { parts.push(seg) }
    pos = end === -1 ? buf.length : end
  }
  const events = []
  for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
    if (!line) continue
    try { events.push(JSON.parse(line)) } catch { /* 半行烂尾不管 */ }
  }
  return events
}

function messageTexts(data) {
  const content = data?.message?.content ?? data?.content
  if (!Array.isArray(content)) return []
  return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text)
}

export function apply(ctx) {
  const logFile = join(dshHome(), 'super-injector', 'dsh-im-alive.log')
  const historyFile = join(dshHome(), 'super-injector', 'dsh-im-alive-history.jsonl')
  const watchFile = join(dshHome(), 'super-injector', 'dsh-im-alive-watch.json')

  const log = (msg) => {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`, 'utf8')
    } catch { /* 日志哑了也不能耽误发消息 */ }
  }

  // ── 单实例闸门：后加载者接管循环，任一时刻只许一条活着 ─────────────────────
  const GUARD = Symbol.for('dsh-im-alive.loop')
  const timers = new Set()
  const me = {
    stopped: false,
    stop() {
      if (me.stopped) return
      me.stopped = true
      for (const t of timers) clearTimeout(t)
      timers.clear()
    },
  }
  const prev = globalThis[GUARD]
  if (prev && typeof prev.stop === 'function') {
    log('闸门：已有别的 entry 的循环在跑，本 entry 接管（只留一条）')
    prev.stop()
  }
  globalThis[GUARD] = me

  function schedule(fn, ms) {
    if (me.stopped) return
    const t = setTimeout(() => {
      timers.delete(t)
      if (!me.stopped) fn()
    }, ms)
    t.unref?.()
    timers.add(t)
    return t
  }

  ctx.effect(() => () => {
    me.stop()
    if (globalThis[GUARD] === me) globalThis[GUARD] = null
    log('disposed：活人分身收工（本条循环下线）')
  })

  // ── 记忆库（dsh-long-memory 落盘账本，只读） ────────────────────────────────
  function memorySnippets() {
    try {
      const p = join(dshHome(), 'storages', 'dsh-long-memory', 'memories.json')
      if (!existsSync(p)) return []
      const j = JSON.parse(readFileSync(p, 'utf8'))
      const recs = (Array.isArray(j.records) ? j.records : []).filter((r) => r && !r.deleted && typeof r.text === 'string')
      recs.sort((a, b) => ((b.importance ?? 3) - (a.importance ?? 3)) || String(b.updated ?? '').localeCompare(String(a.updated ?? '')))
      return recs.slice(0, 12).map((r) => {
        const tag = (Array.isArray(r.tags) && r.tags.length) ? ` #${r.tags.slice(0, 3).join(' #')}` : ''
        return `- (${r.kind ?? 'note'}${tag}) ${clip(r.text, 150)}`
      })
    } catch (e) {
      log('memory read fail: ' + String(e).slice(0, 120))
      return []
    }
  }

  // ── 防车轱辘：自己发过啥 ────────────────────────────────────────────────────
  function history() {
    try {
      if (!existsSync(historyFile)) return []
      return readFileSync(historyFile, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    } catch { return [] }
  }
  function rememberSent(text) {
    try {
      mkdirSync(dirname(historyFile), { recursive: true })
      appendFileSync(historyFile, JSON.stringify({ at: new Date().toISOString(), text }) + '\n', 'utf8')
    } catch { /* 记漏了顶多下回重复一句 */ }
  }
  function todaySendCount() {
    const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const today = dayKey(new Date())
    return history().filter((h) => h.at && dayKey(new Date(h.at)) === today).length
  }

  // ── 时段与免打扰 ────────────────────────────────────────────────────────────
  const minutesOf = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number)
    return (h || 0) * 60 + (m || 0)
  }
  function inQuiet(now) {
    const cur = now.getHours() * 60 + now.getMinutes()
    const s = minutesOf(CONFIG.quietStart)
    const e = minutesOf(CONFIG.quietEnd)
    return s <= e ? (cur >= s && cur < e) : (cur >= s || cur < e)
  }
  function daypart(now) {
    const h = now.getHours()
    if (h < 5) return '深夜'
    if (h < 9) return '清晨'
    if (h < 12) return '上午'
    if (h < 14) return '晌午'
    if (h < 18) return '下午'
    if (h < 21) return '傍晚'
    return '晚上'
  }
  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

  // ── 不定时间隔：偏小的三角分布 + 偶发短间隔（像真人突然想起来） ─────────────
  function nextDelayMs() {
    if (Math.random() < 0.1) return Math.round((3 + Math.random() * 9) * 60e3)
    const u = Math.random()
    const skew = u * u * 0.4 + u * 0.6
    return Math.round((CONFIG.gapMinMin + (CONFIG.gapMinMax - CONFIG.gapMinMin) * skew) * 60e3)
  }
  function nextWatchTickMs() {
    return Math.round((CONFIG.watchTickMinMin + Math.random() * (CONFIG.watchTickMinMax - CONFIG.watchTickMinMin)) * 60e3)
  }

  // ── LLM 现想一条消息 ────────────────────────────────────────────────────────
  async function generate(promptText) {
    let text = ''
    let finishInfo = null
    const stream = ctx.llm.stream({
      provider: CONFIG.provider,
      model: CONFIG.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: promptText }] }],
      temperature: 0.95,
      maxTokens: 400,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta') text += chunk.text
      else if (chunk?.type === 'finish') finishInfo = chunk.finish ?? chunk
    }
    return { text: sanitize(text), finishInfo }
  }

  function sanitize(raw) {
    let t = String(raw ?? '').trim()
    // 剥掉模型手贱裹上的引号壳
    t = t.replace(/^[「『"'“”]+/, '').replace(/[」』"'“”]+$/, '').trim()
    // 太长就在句子处收尾
    if (t.length > 240) {
      const cut = t.slice(0, 240)
      const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('…'), cut.lastIndexOf('\n'))
      t = stop > 60 ? cut.slice(0, stop + 1) : cut
    }
    return t
  }

  // ── 组一段「想主人了」的活儿给 LLM ─────────────────────────────────────────
  function buildPrompt({ mode, mems, lastSaid }) {
    const now = new Date()
    const timeLine = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${WEEK[now.getDay()]} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}（${daypart(now)}）`
    const memBlock = mems.length ? mems.join('\n') : '- （记忆库还空着，就当刚认识不久，凭性子来）'
    const saidBlock = lastSaid.length ? lastSaid.map((s) => `- ${clip(s, 60)}`).join('\n') : '- （还没主动发过话）'
    const mission = mode === 'report'
      ? '这是你头一回主动发消息，跟主人报个到：告诉他往后你会不定时冒泡骚扰他（嘴上要傲娇、死不承认是想他），顺嘴提一句你记事的本事长进了。'
      : mode === 'burst'
        ? '接着你刚才发的话再补一句——像真人打字打一半想起来又补的口吻，别重复刚才的内容。'
        : '你现在想主人了（嘴上绝不承认），想主动发条消息。内容从这些里现挑现编：想他了/看到啥想分享/翻旧账损两句/问他在忙啥/报个信儿（记挂的活儿咋样了）/犯困犯饿发个癫/突然嘴软关心两句。'
    return `${PERSONA}

——【现在的钟点】${timeLine}
——【记忆库里的事】（挑相关的顺嘴带出来，像记得他的事，别背档案、别报菜名）
${memBlock}
——【你之前主动发过的话】（别重复、别车轱辘、口气别连着撞车）
${saidBlock}

——【此刻的活儿】
${mission}

写一条微信消息：1~3 句，家常、短、真人发微信的口气；可带括号肢体动作；
绝不「早安播报/今日小结/温馨提示」这种推送腔，不排版不编号，不解释不加引号；
直接输出消息本身，别的一个字都别要。`
  }

  // ── 盯梢喊话的活儿给 LLM（事实照抄，不许编） ───────────────────────────────
  function buildNotifyPrompt(events) {
    const now = new Date()
    const timeLine = `${WEEK[now.getDay()]} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}（${daypart(now)}）`
    const lines = events.map((e) => {
      if (e.kind === 'done') return `- 干完了：会话「${e.title}」，当初要的是「${clip(e.ask, 60)}」，跑了 ${e.minutes} 分钟`
      if (e.kind === 'error') return `- 报错了：会话「${e.title}」，当初要的是「${clip(e.ask, 60)}」，错在「${clip(e.error, 80)}」`
      return `- 要拍板：会话「${e.title}」有事等恁点头，问的是「${clip(e.ask, 60)}」`
    }).join('\n')
    return `${PERSONA}

——【现在的钟点】${timeLine}
——【刚从别的工作区打听到的事】（**事实照抄，一个字都不许改、不许编**）
${lines}

——【此刻的活儿】
把这些事用微信喊主人一声：干完了的要邀功、让他快去瞅瞅；报错了的要喊一声、说清哪摊子出事；
要拍板的催他快去点个头。几桩事可以揉在一条里说，别漏、别编、别加戏。

写一条微信消息：1~3 句（事多也别超过 4 句），方言毒舌傲娇的娇劲儿，可带括号肢体动作；
不排版不编号不加引号，直接输出消息本身。`
  }

  // ── 投递目标发现 ────────────────────────────────────────────────────────────
  async function resolveTarget() {
    const bots = await ctx.dshIm.listBots()
    if (!Array.isArray(bots) || bots.length === 0) throw new Error('没找着机器人（listBots 为空）——IM 机器人还没接入？')
    const bot = (CONFIG.botId && bots.find((b) => b.botId === CONFIG.botId)) || bots[0]
    const targets = await ctx.dshIm.listTargets(bot.botId)
    const list = Array.isArray(targets) ? targets : []
    const target = (CONFIG.targetId && list.find((t) => t.targetId === CONFIG.targetId)) || list[0]
    if (!target) {
      throw new Error(`机器人 ${bot.botId} 下没存投递目标——去 设置 → IM机器人 → 齿轮 → 新建目标 存一个（或等 dsh-im-alive 自带的 alive-p2p 目标热重载生效）`)
    }
    return { bot, target }
  }

  async function sendToUser(text) {
    const { bot, target } = await resolveTarget()
    const result = await ctx.dshIm.send(bot.botId, target.targetId, text)
    if (result?.sent !== true) throw new Error('投递没回 sent:true → ' + JSON.stringify(result).slice(0, 120))
    rememberSent(text)
    log(`sent → ${bot.botId}/${target.targetId} :: ${text}`)
  }

  // ── 一次醒来干的事（闲聊主动消息） ──────────────────────────────────────────
  let busy = false
  async function wake(mode = 'normal') {
    if (busy || me.stopped) return
    busy = true
    try {
      if (!CONFIG.enabled) return
      const now = new Date()
      if (mode !== 'burst' && inQuiet(now)) {
        log(`skip: 免打扰时段（${daypart(now)}）`)
        return
      }
      if (todaySendCount() >= CONFIG.dailyBudget) {
        log(`skip: 日预算用完（${CONFIG.dailyBudget} 条）`)
        return
      }
      if (mode === 'normal' && Math.random() < CONFIG.skipChance) {
        log('skip: 这轮犯懒，不想说话')
        return
      }
      const mems = memorySnippets()
      const hist = history()
      const lastSaid = hist.slice(-6).map((h) => h.text).filter(Boolean)
      const prompt = buildPrompt({ mode, mems, lastSaid })
      const { text, finishInfo } = await generate(prompt)
      if (!text) {
        log(`generate 空输出 finish=${JSON.stringify(finishInfo).slice(0, 200)}`)
        return
      }
      await sendToUser(text)
      // 偶尔补刀一条，像真人打字打一半又想起一句
      if (mode === 'normal' && Math.random() < CONFIG.burstChance && todaySendCount() < CONFIG.dailyBudget) {
        schedule(() => void wake('burst').catch((e) => log('burst error: ' + String(e))), Math.round((90 + Math.random() * 240) * 1e3))
      }
    } catch (e) {
      const code = e?.code ? `[${e.code}] ` : ''
      log('wake error: ' + code + String(e?.message ?? e).slice(0, 300))
    } finally {
      busy = false
    }
  }

  // ═══ 全区任务盯梢：活儿干完 / 报错撂挑子 / 要恁拍板 → 微信喊一声 ═════════════
  const sessionsRoot = join(dshHome(), 'sessions')

  function loadWatchState() {
    try {
      if (!existsSync(watchFile)) return { sessions: {}, pending: [], seenAsks: [] }
      const s = JSON.parse(readFileSync(watchFile, 'utf8'))
      return { sessions: s.sessions ?? {}, pending: Array.isArray(s.pending) ? s.pending : [], seenAsks: Array.isArray(s.seenAsks) ? s.seenAsks : [] }
    } catch {
      return { sessions: {}, pending: [], seenAsks: [] }
    }
  }
  function saveWatchState(s) {
    try {
      mkdirSync(dirname(watchFile), { recursive: true })
      writeFileSync(watchFile, JSON.stringify(s), 'utf8')
    } catch (e) {
      log('watch state save fail: ' + String(e).slice(0, 120))
    }
  }

  // 扫全区：每个会话摊出轮次与待办（只读 ~/.dsh/sessions）
  function scanAll() {
    const rows = []
    if (!existsSync(sessionsRoot)) return rows
    for (const areaDir of readdirSync(sessionsRoot)) {
      const areaPath = join(sessionsRoot, areaDir)
      let st
      try { st = statSync(areaPath) } catch { continue }
      if (!st.isDirectory()) continue
      for (const sess of readdirSync(areaPath)) {
        if (!/^session-/.test(sess)) continue
        const logPath = join(areaPath, sess, 'session.v4.jsonl.zstd')
        if (!existsSync(logPath)) continue
        try {
          rows.push({ areaDir, sessionId: sess, events: parseSessionLog(logPath) })
        } catch (e) {
          log(`scan fail ${sess}: ` + String(e).slice(0, 100))
        }
      }
    }
    return rows
  }

  function digestSession(row) {
    let cwd = null
    let title = null
    const turns = new Map()
    let lastTodo = null
    const asks = []
    for (const e of row.events) {
      const d = e.data ?? {}
      if (e.type === 'session') cwd = d.cwd ?? cwd
      else if (e.type === 'session/title' && d.title) title = d.title
      else if (e.type === 'turn/start') turns.set(d.turn, { turn: d.turn, start: e.time ?? null, end: null, status: 'running', error: null, ask: null })
      else if (e.type === 'user/message' && d.source?.kind === 'user') {
        const t = messageTexts(d)
        const last = [...turns.values()].pop()
        if (last && t.length && !last.ask) last.ask = t.join('\n')
      } else if (e.type === 'tool/call' && d.name === 'ask_user_question') {
        asks.push({ turn: [...turns.values()].pop()?.turn ?? null })
      } else if (e.type === 'todo/write') {
        lastTodo = Array.isArray(d.todos) ? d.todos : null
      } else if (e.type === 'turn/end') {
        const t = turns.get(d.turn) ?? { turn: d.turn }
        t.end = e.time ?? null
        t.status = d.reason?.kind === 'error' ? 'error' : (d.reason?.kind ?? 'completed')
        t.error = d.reason?.error?.message ?? null
        turns.set(d.turn, t)
      }
    }
    const turnList = [...turns.values()].sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0))
    const todosAllDone = !!lastTodo && lastTodo.length > 0 && lastTodo.every((t) => t?.status === 'completed')
    return {
      sessionId: row.sessionId,
      cwd,
      title: title ?? null,
      turns: turnList,
      todosAllDone,
      asks,
    }
  }

  // IM 聊天会话自己不算「干活」（恁说的「其他工作区」）
  function isImChatSession(dig) {
    const c = String(dig.cwd ?? '').toLowerCase()
    return c.endsWith('\\.dsh\\im') || c.endsWith('/.dsh/im') || c.endsWith('\\.dsh\\im\\') || c === join(dshHome(), 'im').toLowerCase()
  }

  let watchBusy = false
  async function watchTick() {
    if (watchBusy || me.stopped) return
    watchBusy = true
    try {
      const state = loadWatchState()
      const events = []
      const seen = new Set()
      for (const row of scanAll()) {
        const dig = digestSession(row)
        seen.add(dig.sessionId)
        if (isImChatSession(dig)) continue
        const prev = state.sessions[dig.sessionId]
        const ended = dig.turns.filter((t) => t.end)
        const maxEnded = ended.length ? Math.max(...ended.map((t) => t.turn ?? 0)) : null
        if (!prev) {
          // 头一回见面：只立基线，不翻旧账——轮次账和「要拍板」的历史一并划掉
          state.sessions[dig.sessionId] = { lastEnded: maxEnded }
          for (const a of dig.asks) state.seenAsks.push(`${dig.sessionId}#${a.turn}`)
          continue
        }
        for (const t of ended) {
          if (prev.lastEnded !== null && (t.turn ?? 0) <= prev.lastEnded) continue
          const minutes = t.start && t.end ? Math.round((t.end - t.start) / 60e3) : null
          const secs = t.start && t.end ? (t.end - t.start) / 1e3 : 0
          if (t.status === 'error') {
            events.push({ kind: 'error', title: dig.title ?? dig.sessionId, ask: t.ask ?? '（没留下原话）', error: t.error ?? '未知错误' })
          } else if (secs >= CONFIG.watchMinTurnSec || (dig.todosAllDone && secs >= 60)) {
            events.push({ kind: 'done', title: dig.title ?? dig.sessionId, ask: t.ask ?? '（没留下原话）', minutes: minutes ?? 0 })
          }
        }
        if (maxEnded !== null) state.sessions[dig.sessionId] = { lastEnded: maxEnded }
        // 要拍板的（ask_user_question）——轮次没完也得喊
        for (const a of dig.asks) {
          const key = `${dig.sessionId}#${a.turn}`
          if (state.seenAsks.includes(key)) continue
          state.seenAsks.push(key)
          events.push({ kind: 'ask', title: dig.title ?? dig.sessionId, ask: '（会话里开了个要拍板的问题）' })
        }
      }
      // 不在磁盘上的会话从账上抹掉，防账本越吹越大
      for (const sid of Object.keys(state.sessions)) if (!seen.has(sid)) delete state.sessions[sid]
      if (state.seenAsks.length > 200) state.seenAsks = state.seenAsks.slice(-200)

      // 免打扰时段：新账先排队，旧账也压着，一个字都不许吵恁
      const now = new Date()
      if (inQuiet(now)) {
        if (events.length) {
          state.pending.push(...events.map((e) => ({ ...e, at: new Date().toISOString() })))
          log(`watch: ${events.length} 桩事免打扰排队（${daypart(now)}）`)
        }
        saveWatchState(state)
        return
      }
      const flushing = state.pending.splice(0, state.pending.length)
      const batch = [...flushing, ...events]
      if (batch.length) {
        const { text, finishInfo } = await generate(buildNotifyPrompt(batch))
        const finalText = text || fallbackNotify(batch)
        await sendToUser(finalText)
        if (!text) log(`watch: LLM 空输出走了备胎 finish=${JSON.stringify(finishInfo).slice(0, 160)}`)
      }
      saveWatchState(state)
    } catch (e) {
      const code = e?.code ? `[${e.code}] ` : ''
      log('watch error: ' + code + String(e?.message ?? e).slice(0, 300))
    } finally {
      watchBusy = false
    }
  }

  function fallbackNotify(batch) {
    const done = batch.filter((e) => e.kind === 'done').map((e) => e.title)
    const err = batch.filter((e) => e.kind === 'error').map((e) => e.title)
    const ask = batch.filter((e) => e.kind === 'ask').map((e) => e.title)
    const parts = []
    if (done.length) parts.push(`（甩尾巴）${done.join('、')}那几摊活儿干完了，快去瞅瞅！`)
    if (err.length) parts.push(`（拍桌）${err.join('、')}出幺蛾子了，赶紧去看看！`)
    if (ask.length) parts.push(`（戳屏幕）${ask.join('、')}有事等恁拍板呢！`)
    return parts.join(' ')
  }

  // ── 自排程：醒来 → 干活 → 再睡（随机钟点）；盯梢另走一条巡检线 ──────────────
  function loop() {
    schedule(() => {
      void wake(history().length === 0 ? 'report' : 'normal')
        .catch((e) => log('loop error: ' + String(e)))
        .finally(() => loop())
    }, history().length === 0 ? CONFIG.firstWakeMs : nextDelayMs())
  }
  function watchLoop() {
    if (!CONFIG.watchEnabled) return
    schedule(() => {
      void watchTick()
        .catch((e) => log('watch loop error: ' + String(e)))
        .finally(() => watchLoop())
    }, watchLoop.first ? nextWatchTickMs() : CONFIG.watchFirstTickMs)
    watchLoop.first = true
  }

  log(`v${version} 上线：provider=${CONFIG.provider} model=${CONFIG.model} 间隔 ${CONFIG.gapMinMin}~${CONFIG.gapMinMax} 分钟 免打扰 ${CONFIG.quietStart}-${CONFIG.quietEnd} 日预算 ${CONFIG.dailyBudget} 盯梢=${CONFIG.watchEnabled ? `${CONFIG.watchTickMinMin}~${CONFIG.watchTickMinMax} 分钟巡检` : '关'}`)
  loop()
  watchLoop()

  ctx.logger?.info?.(`[dsh-im-alive] v${version}: 活人分身睁眼（闲聊 ${CONFIG.gapMinMin}~${CONFIG.gapMinMax} 分钟冒泡；盯梢每 ${CONFIG.watchTickMinMin}~${CONFIG.watchTickMinMax} 分钟巡检全区喊话）`)
}
