import { listRows } from './local-store'
import type {
  CacheCatalogView,
  CacheConflictStrategy,
  CacheEngineState,
  CacheEntry,
  CacheHitDetail,
  CacheInvalidationEvent,
  CacheReadResult,
  EntryRow,
} from './types'

// 查询缓存引擎：按依赖版本失效，不再「策略一变全清」。
// 状态独立持久化到 localStorage，刷新页面后命中明细仍可回看。
const ENGINE_STORAGE_KEY = 'data-explore-studio:query-cache'

// 缓存命中结果字段明细的列定义：页面表格与导出文件共用同一份，保证明细一致、不错位。
export const CACHE_HIT_DETAIL_COLUMNS = [
  '明细编号',
  '缓存键',
  '目标查询',
  '缓存策略',
  '依赖数据集',
  '数据版本',
  '版本标识',
  '命中时间',
  '结果字段明细',
  '判定依据',
]

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let idSeq = 0
function nextId(prefix: string): string {
  idSeq += 1
  return `${prefix}-${Date.now()}-${idSeq}`
}

export function formatCacheTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function findQueryRow(queryCode: string): EntryRow | undefined {
  return listRows('query').find((row) => String(row['语句编号']) === queryCode)
}

function findPolicyForQuery(queryCode: string): EntryRow | undefined {
  return listRows('cache').find(
    (row) => String(row['目标查询']) === queryCode && String(row.status) === '已启用',
  )
}

function resultFieldsOf(query: EntryRow): Record<string, string> {
  return {
    返回字段: String(query['返回字段'] ?? ''),
    排序条件: String(query['排序条件'] ?? ''),
    分页大小: String(query['分页大小'] ?? ''),
    最大行数: String(query['最大行数'] ?? ''),
  }
}

function buildEntry(
  policy: EntryRow,
  query: EntryRow,
  datasetVersion: number,
  now: number,
): CacheEntry {
  const ttlRaw = Number(policy['过期秒数'])
  const ttlSeconds = Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.floor(ttlRaw) : 300
  return {
    cacheKey: `${String(policy['策略编号'])}:${String(query['语句编号'])}`,
    queryCode: String(query['语句编号']),
    policyCode: String(policy['策略编号']),
    datasetCode: String(query['目标数据集']),
    datasetVersion,
    ttlSeconds,
    createdAt: now,
    expiresAt: now + ttlSeconds * 1000,
    stale: false,
    status: 'active',
    fields: resultFieldsOf(query),
  }
}

function seedState(): CacheEngineState {
  const datasetVersions: Record<string, number> = {}
  for (const row of listRows('datastore')) {
    const code = String(row['数据集编号'] ?? '')
    if (code) {
      datasetVersions[code] = 1
    }
  }
  const now = Date.now()
  const entries: CacheEntry[] = []
  for (const policy of listRows('cache')) {
    if (String(policy.status) !== '已启用') {
      continue
    }
    const queryCode = String(policy['目标查询'] ?? '')
    const query = findQueryRow(queryCode)
    if (!query) {
      continue
    }
    const datasetCode = String(query['目标数据集'])
    entries.push(buildEntry(policy, query, datasetVersions[datasetCode] ?? 1, now))
  }
  return {
    datasetVersions,
    entries,
    details: [],
    invalidations: [],
    hits: 0,
    misses: 0,
    conflictStrategy: 'switch-new',
    seededAt: now,
  }
}

let stateCache: CacheEngineState | null = null

function persist(state: CacheEngineState): void {
  stateCache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(ENGINE_STORAGE_KEY, JSON.stringify(state))
  }
}

export function ensureCacheState(): CacheEngineState {
  if (stateCache) {
    return stateCache
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    const raw = window.localStorage.getItem(ENGINE_STORAGE_KEY)
    if (raw) {
      try {
        stateCache = JSON.parse(raw) as CacheEngineState
        return stateCache
      } catch {
        // 解析失败则按初始状态重建
      }
    }
  }
  const seeded = seedState()
  persist(seeded)
  return seeded
}

export function resetCacheEngine(): CacheEngineState {
  const seeded = seedState()
  persist(seeded)
  return seeded
}

/** 同一条目只失效一次：依赖版本与过期时间同时到期时也只产生一次失效 */
function invalidateEntry(entry: CacheEntry, reason: string): boolean {
  if (entry.status !== 'active') {
    return false
  }
  entry.status = 'invalidated'
  entry.invalidatedAt = Date.now()
  entry.invalidatedReason = reason
  return true
}

function pushInvalidation(
  state: CacheEngineState,
  trigger: string,
  entry: CacheEntry,
  toVersion: number,
  basis: string,
): void {
  state.invalidations.push({
    id: nextId('INV'),
    at: Date.now(),
    trigger,
    datasetCode: entry.datasetCode,
    fromVersion: entry.datasetVersion,
    toVersion,
    affectedQueries: [entry.queryCode],
    clearedKeys: [entry.cacheKey],
    staleKeys: [],
    basis,
  })
}

function recordHit(
  state: CacheEngineState,
  entry: CacheEntry,
  requestId: string | undefined,
  stale: boolean,
): CacheReadResult {
  // 缓存命中读取查询缓存后形成命中结果字段明细，缓存策略与数据版本随结果归档
  const detail: CacheHitDetail = {
    id: nextId('HIT'),
    requestId: requestId ?? nextId('REQ'),
    cacheKey: entry.cacheKey,
    queryCode: entry.queryCode,
    policyCode: entry.policyCode,
    datasetCode: entry.datasetCode,
    datasetVersion: entry.datasetVersion,
    stale,
    hitAt: Date.now(),
    fields: clone(entry.fields),
    basis: stale
      ? `命中 ${entry.cacheKey}：旧版续服，完整结果保持 ${entry.datasetCode}@v${entry.datasetVersion} 自身版本标识，不回填新版本`
      : `命中 ${entry.cacheKey}：依赖版本 ${entry.datasetCode}@v${entry.datasetVersion} 与当前版本一致，TTL ${entry.ttlSeconds}s 未到期`,
  }
  state.details.push(detail)
  state.hits += 1
  persist(state)
  return {
    outcome: stale ? 'stale-hit' : 'hit',
    detail,
    message: stale
      ? `${entry.queryCode} 命中旧版续服条目 ${entry.cacheKey}（${entry.datasetCode}@v${entry.datasetVersion}），明细 ${detail.id} 已归档`
      : `${entry.queryCode} 命中 ${entry.cacheKey}（${entry.datasetCode}@v${entry.datasetVersion}），明细 ${detail.id} 已归档`,
  }
}

export function readQueryCache(queryCode: string, requestId?: string): CacheReadResult {
  const state = ensureCacheState()
  // 并发重试去重：同一请求标识只保留一份缓存命中结果字段明细依据
  if (requestId) {
    const existed = state.details.find((item) => item.requestId === requestId)
    if (existed) {
      return {
        outcome: 'deduped',
        detail: existed,
        message: `并发重试去重：沿用已有明细依据 ${existed.id}，不重复归档`,
      }
    }
  }
  const query = findQueryRow(queryCode)
  if (!query) {
    return { outcome: 'miss', message: `没有找到查询 ${queryCode}，无法读取缓存` }
  }
  const policy = findPolicyForQuery(queryCode)
  if (!policy) {
    state.misses += 1
    persist(state)
    return { outcome: 'miss', message: `${queryCode} 没有已启用的缓存策略，本次未命中` }
  }
  const cacheKey = `${String(policy['策略编号'])}:${queryCode}`
  const entry = state.entries.find((item) => item.cacheKey === cacheKey && item.status === 'active')
  const now = Date.now()
  if (entry) {
    const currentVersion = state.datasetVersions[entry.datasetCode] ?? entry.datasetVersion
    const expired = now >= entry.expiresAt
    const versionMatch = entry.datasetVersion === currentVersion
    if (entry.stale && !expired) {
      // 旧版续服：旧完整结果带着自身版本标识继续可见
      return recordHit(state, entry, requestId, true)
    }
    if (expired && !versionMatch) {
      // 兜底：依赖版本与过期时间同时到期，只产生一次失效
      const reason = `冲突：${entry.datasetCode} 版本与 TTL 同时到期，按「立即切到新版本」清理`
      if (invalidateEntry(entry, reason)) {
        pushInvalidation(state, 'conflict', entry, currentVersion, `${entry.cacheKey} ${reason}`)
      }
    } else if (expired) {
      const reason = `TTL ${entry.ttlSeconds}s 到期`
      if (invalidateEntry(entry, reason)) {
        pushInvalidation(state, 'ttl-expiry', entry, currentVersion, `${entry.cacheKey} ${reason}`)
      }
    } else if (!versionMatch) {
      const reason = `依赖数据集 ${entry.datasetCode} 已升到 v${currentVersion}，按依赖版本失效`
      if (invalidateEntry(entry, reason)) {
        pushInvalidation(state, 'dataset-version', entry, currentVersion, `${entry.cacheKey} ${reason}`)
      }
    } else {
      return recordHit(state, entry, requestId, false)
    }
  }
  // 未命中：按当前数据版本与当前策略 TTL 快照重建条目
  state.misses += 1
  const datasetCode = String(query['目标数据集'])
  const fresh = buildEntry(policy, query, state.datasetVersions[datasetCode] ?? 1, now)
  state.entries.push(fresh)
  persist(state)
  return {
    outcome: 'miss',
    message: `${queryCode} 未命中，已按 ${fresh.datasetCode}@v${fresh.datasetVersion} 重建缓存条目 ${fresh.cacheKey}`,
  }
}

/** 并发重试：同一请求标识重试多次，只保留一份命中明细依据 */
export function retryQueryCache(queryCode: string, attempts = 3): CacheReadResult {
  const requestId = nextId('REQ')
  let last: CacheReadResult = { outcome: 'miss', message: '' }
  for (let i = 0; i < attempts; i += 1) {
    last = readQueryCache(queryCode, requestId)
  }
  if (last.detail) {
    return {
      ...last,
      message: `并发重试 ${attempts} 次（请求标识 ${requestId}），只保留一份命中明细依据 ${last.detail.id}`,
    }
  }
  return { ...last, message: `并发重试 ${attempts} 次仍未命中 ${queryCode}` }
}

/** 数据集升版：只清依赖该数据集的查询条目，未受影响条目继续命中 */
export function upgradeDatasetVersion(datasetCode: string): CacheInvalidationEvent {
  const state = ensureCacheState()
  const fromVersion = state.datasetVersions[datasetCode] ?? 1
  const toVersion = fromVersion + 1
  state.datasetVersions[datasetCode] = toVersion
  const now = Date.now()
  const affected = state.entries.filter(
    (item) => item.status === 'active' && item.datasetCode === datasetCode,
  )
  const clearedKeys: string[] = []
  const staleKeys: string[] = []
  const bases: string[] = []
  let conflictCount = 0
  for (const entry of affected) {
    const expired = now >= entry.expiresAt
    if (expired) {
      // 数据集更新与 TTL 到期同时发生：两条路径都只暴露一个完整版本，冲突判定保留依据
      conflictCount += 1
      if (state.conflictStrategy === 'serve-stale') {
        entry.stale = true
        entry.expiresAt = now + entry.ttlSeconds * 1000
        staleKeys.push(entry.cacheKey)
        bases.push(
          `${entry.cacheKey} 升版与 TTL 到期冲突，按「旧版续服」保留 ${datasetCode}@v${fromVersion} 完整结果并顺延一个 TTL 周期`,
        )
      } else {
        const reason = `冲突：${datasetCode} 升版 v${fromVersion}→v${toVersion} 与 TTL 到期同时发生，按「立即切到新版本」清理`
        if (invalidateEntry(entry, reason)) {
          clearedKeys.push(entry.cacheKey)
          bases.push(`${entry.cacheKey} ${reason}，旧完整结果不再暴露`)
        }
      }
    } else {
      const reason = `依赖数据集 ${datasetCode} 升版 v${fromVersion}→v${toVersion}，按依赖版本失效`
      if (invalidateEntry(entry, reason)) {
        clearedKeys.push(entry.cacheKey)
        bases.push(`${entry.cacheKey} ${reason}`)
      }
    }
  }
  const event: CacheInvalidationEvent = {
    id: nextId('INV'),
    at: now,
    trigger: conflictCount > 0 ? 'conflict' : 'dataset-version',
    datasetCode,
    fromVersion,
    toVersion,
    affectedQueries: [...new Set(affected.map((item) => item.queryCode))],
    clearedKeys,
    staleKeys,
    basis: bases.length
      ? bases.join('；')
      : `${datasetCode} 升版 v${fromVersion}→v${toVersion}，没有受影响的缓存条目`,
  }
  state.invalidations.push(event)
  persist(state)
  return event
}

/** 手动刷新条目：立即切到当前数据版本，旧条目只失效一次 */
export function refreshCacheEntry(cacheKey: string): CacheReadResult {
  const state = ensureCacheState()
  const entry = state.entries.find((item) => item.cacheKey === cacheKey && item.status === 'active')
  if (!entry) {
    return { outcome: 'miss', message: `条目 ${cacheKey} 不存在或已失效` }
  }
  const query = findQueryRow(entry.queryCode)
  const policy = listRows('cache').find(
    (row) => String(row['策略编号']) === entry.policyCode && String(row.status) === '已启用',
  )
  if (!query || !policy) {
    return { outcome: 'miss', message: `${entry.queryCode} 或策略 ${entry.policyCode} 已不可用` }
  }
  const currentVersion = state.datasetVersions[entry.datasetCode] ?? entry.datasetVersion
  const reason = `手动刷新：立即切到 ${entry.datasetCode}@v${currentVersion}`
  if (invalidateEntry(entry, reason)) {
    pushInvalidation(state, 'manual-refresh', entry, currentVersion, `${entry.cacheKey} ${reason}`)
  }
  const fresh = buildEntry(policy, query, currentVersion, Date.now())
  state.entries.push(fresh)
  persist(state)
  return {
    outcome: 'miss',
    message: `${cacheKey} 已刷新为 ${fresh.datasetCode}@v${fresh.datasetVersion}，旧完整结果不再暴露`,
  }
}

export function setCacheConflictStrategy(strategy: CacheConflictStrategy): void {
  const state = ensureCacheState()
  state.conflictStrategy = strategy
  persist(state)
}

export function cacheCatalog(): CacheCatalogView {
  const state = ensureCacheState()
  const totalReads = state.hits + state.misses
  return {
    datasetVersions: { ...state.datasetVersions },
    entries: [...state.entries].sort(
      (a, b) => a.cacheKey.localeCompare(b.cacheKey) || b.createdAt - a.createdAt,
    ),
    hits: state.hits,
    misses: state.misses,
    hitRate: totalReads === 0 ? 0 : state.hits / totalReads,
    invalidatedCount: state.entries.filter((item) => item.status === 'invalidated').length,
    conflictStrategy: state.conflictStrategy,
  }
}

/** 命中明细按目标查询过滤：失效与命中明细只对受影响查询可见 */
export function listCacheHitDetails(queryCode?: string): CacheHitDetail[] {
  const state = ensureCacheState()
  const details = queryCode
    ? state.details.filter((item) => item.queryCode === queryCode)
    : state.details
  return [...details].sort((a, b) => b.hitAt - a.hitAt)
}

export function listCacheInvalidations(queryCode?: string): CacheInvalidationEvent[] {
  const state = ensureCacheState()
  const events = queryCode
    ? state.invalidations.filter((item) => item.affectedQueries.includes(queryCode))
    : state.invalidations
  return [...events].sort((a, b) => b.at - a.at)
}

/** 明细行映射：页面表格与导出文件共用，保证列不错位 */
export function cacheHitDetailRow(detail: CacheHitDetail): Record<string, string> {
  return {
    明细编号: detail.id,
    缓存键: detail.cacheKey,
    目标查询: detail.queryCode,
    缓存策略: detail.policyCode,
    依赖数据集: detail.datasetCode,
    数据版本: `v${detail.datasetVersion}`,
    版本标识: detail.stale ? '旧版续服' : '当前版本',
    命中时间: formatCacheTime(detail.hitAt),
    结果字段明细: Object.entries(detail.fields)
      .map(([key, value]) => `${key}=${value}`)
      .join('；'),
    判定依据: detail.basis,
  }
}
