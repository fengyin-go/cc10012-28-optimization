/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 查询缓存引擎：条目、命中明细与失效事件的结构。 */

export type CacheEntryStatus = 'active' | 'invalidated'

export type CacheEntry = {
  cacheKey: string
  queryCode: string
  policyCode: string
  datasetCode: string
  /** 写入时依赖数据集的版本标识：旧完整结果只带自身版本继续可见，不回填新版本 */
  datasetVersion: number
  /** 写入时的 TTL 快照：策略调整过期秒数不影响已写入条目 */
  ttlSeconds: number
  createdAt: number
  expiresAt: number
  /** 冲突策略为「旧版续服」时置真：带版本标识继续提供旧完整结果 */
  stale: boolean
  status: CacheEntryStatus
  invalidatedAt?: number
  invalidatedReason?: string
  fields: Record<string, string>
}

/** 缓存命中结果字段明细：命中查询缓存后形成，缓存策略与数据版本随结果归档 */
export type CacheHitDetail = {
  id: string
  /** 并发重试去重键：同一请求标识只保留一份明细依据 */
  requestId: string
  cacheKey: string
  queryCode: string
  policyCode: string
  datasetCode: string
  datasetVersion: number
  stale: boolean
  hitAt: number
  fields: Record<string, string>
  basis: string
}

export type CacheInvalidationEvent = {
  id: string
  at: number
  trigger: string
  datasetCode: string
  fromVersion: number
  toVersion: number
  /** 失效只对受影响查询可见 */
  affectedQueries: string[]
  clearedKeys: string[]
  staleKeys: string[]
  /** 冲突判定保留的依据 */
  basis: string
}

/** 数据集更新与 TTL 到期同时发生时的两条路径：立即切新版本 / 旧版续服 */
export type CacheConflictStrategy = 'switch-new' | 'serve-stale'

export type CacheEngineState = {
  datasetVersions: Record<string, number>
  entries: CacheEntry[]
  details: CacheHitDetail[]
  invalidations: CacheInvalidationEvent[]
  hits: number
  misses: number
  conflictStrategy: CacheConflictStrategy
  seededAt: number
}

export type CacheCatalogView = {
  datasetVersions: Record<string, number>
  entries: CacheEntry[]
  hits: number
  misses: number
  hitRate: number
  invalidatedCount: number
  conflictStrategy: CacheConflictStrategy
}

export type CacheReadResult = {
  outcome: 'hit' | 'stale-hit' | 'miss' | 'deduped'
  message: string
  detail?: CacheHitDetail
}
