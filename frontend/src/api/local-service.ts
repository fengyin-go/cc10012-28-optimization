import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import * as cacheEngine from '@/data/query-cache'
import type {
  ActionResult,
  CacheCatalogView,
  CacheConflictStrategy,
  CacheHitDetail,
  CacheInvalidationEvent,
  CacheReadResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

export { CACHE_HIT_DETAIL_COLUMNS, cacheHitDetailRow, formatCacheTime } from '@/data/query-cache'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  if (key === 'query' && action === '启动查询') {
    // 缓存命中结果字段明细的更新点：查询启动顺着现有调用链读一次查询缓存，
    // 命中即归档明细，未命中则按当前数据版本重建条目。
    const queryCode = String(updated['语句编号'] ?? '')
    if (queryCode) {
      const read = cacheEngine.readQueryCache(queryCode)
      return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」；${read.message}` }
    }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  if (key === 'cache' || key === 'query' || key === 'datastore') {
    // 缓存目录依赖查询、数据集与策略定义，一并重建，避免旧缓存键跨版本误命中
    cacheEngine.resetCacheEngine()
  }
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// —— 查询缓存：按依赖版本失效、命中明细归档与导出 ——

export function cacheCatalogView(): CacheCatalogView {
  return cacheEngine.cacheCatalog()
}

export function listCacheHitDetails(queryCode?: string): CacheHitDetail[] {
  return cacheEngine.listCacheHitDetails(queryCode)
}

export function listCacheInvalidations(queryCode?: string): CacheInvalidationEvent[] {
  return cacheEngine.listCacheInvalidations(queryCode)
}

export function readQueryCache(queryCode: string): CacheReadResult {
  return cacheEngine.readQueryCache(queryCode)
}

export function retryQueryCache(queryCode: string): CacheReadResult {
  return cacheEngine.retryQueryCache(queryCode)
}

export function refreshCacheEntry(cacheKey: string): CacheReadResult {
  return cacheEngine.refreshCacheEntry(cacheKey)
}

export function upgradeDatasetVersion(datasetCode: string): CacheInvalidationEvent {
  return cacheEngine.upgradeDatasetVersion(datasetCode)
}

export function setCacheConflictStrategy(strategy: CacheConflictStrategy): void {
  cacheEngine.setCacheConflictStrategy(strategy)
}

/** 调整策略 TTL：只影响新写入的条目，不立即清空缓存目录 */
export function adjustCachePolicyTtl(policyCode: string, ttlSeconds: number): ActionResult {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return { ok: false, message: '过期秒数必须是正整数' }
  }
  const rows = listRows('cache')
  const index = rows.findIndex((row) => String(row['策略编号']) === policyCode)
  if (index < 0) {
    return { ok: false, message: `没有找到策略 ${policyCode}` }
  }
  const ttl = Math.floor(ttlSeconds)
  const next = [...rows]
  next[index] = { ...rows[index], 过期秒数: String(ttl) }
  saveRows('cache', next)
  return {
    ok: true,
    message: `${policyCode} 的过期秒数已调为 ${ttl}，只影响新写入条目，缓存目录未清空`,
  }
}

/** 缓存命中结果字段明细写出下游文件：列定义与页面明细表一致 */
export function exportCacheHitDetails(queryCode?: string): { filename: string; content: string } {
  const details = cacheEngine.listCacheHitDetails(queryCode)
  const header = cacheEngine.CACHE_HIT_DETAIL_COLUMNS.join(',')
  const lines = [header]
  for (const detail of details) {
    const row = cacheEngine.cacheHitDetailRow(detail)
    lines.push(cacheEngine.CACHE_HIT_DETAIL_COLUMNS.map((column) => row[column] ?? '').join(','))
  }
  const suffix = queryCode ? `-${queryCode}` : ''
  return { filename: `缓存命中结果字段明细${suffix}.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadCacheHitDetails(queryCode?: string): void {
  const { filename, content } = exportCacheHitDetails(queryCode)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
