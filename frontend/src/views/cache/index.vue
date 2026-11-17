<template>
  <section class="page" data-module="cache">
    <header class="page-head">
      <div>
        <h2>查询缓存管理</h2>
        <p class="page-desc">维护查询缓存策略的输入、执行约束与结果记录，为查询加速提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记缓存策略</button>
        <button class="btn" type="button" @click="exportRows">导出查询缓存清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无查询缓存数据，可先登记缓存策略</td>
        </tr>
      </tbody>
    </table>

    <section class="cache-panel">
      <header class="panel-head">
        <div>
          <h3>缓存运行核对</h3>
          <p class="page-desc">按依赖版本失效：数据集升版只清受影响的查询条目，未受影响条目继续命中；失效条目、命中率与数据版本在此核对。</p>
        </div>
      </header>
      <div class="stat-row">
        <article class="stat-card">
          <span class="stat-label">缓存命中率</span>
          <strong class="stat-value">{{ hitRateText }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">生效条目</span>
          <strong class="stat-value">{{ activeEntryCount }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">失效条目</span>
          <strong class="stat-value">{{ catalog.invalidatedCount }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">命中 / 未命中</span>
          <strong class="stat-value">{{ catalog.hits }} / {{ catalog.misses }}</strong>
        </article>
      </div>

      <div class="version-row">
        <span v-for="item in datasetVersionList" :key="item.code" class="legend-item">
          {{ item.code }}@v{{ item.version }}
          <button class="link" type="button" @click="upgradeDataset(item.code)">升版</button>
        </span>
      </div>

      <div class="strategy-row">
        <span class="strategy-label">冲突策略（数据集更新与 TTL 到期同时发生，两种路径都只暴露一个完整版本）：</span>
        <label>
          <input v-model="conflictStrategy" type="radio" value="switch-new" @change="applyStrategy" />
          立即切到新版本
        </label>
        <label>
          <input v-model="conflictStrategy" type="radio" value="serve-stale" @change="applyStrategy" />
          旧版续服（带版本标识）
        </label>
      </div>

      <form class="filter-bar" @submit.prevent="applyTtl">
        <label class="filter-item">
          <span>调整策略 TTL（不立即清空目录）</span>
          <input v-model="ttlPolicyCode" placeholder="策略编号，如 CACH-0003" />
        </label>
        <label class="filter-item">
          <span>新过期秒数</span>
          <input v-model="ttlSecondsInput" placeholder="正整数秒数" />
        </label>
        <button class="btn" type="submit">调整 TTL</button>
      </form>
    </section>

    <section class="cache-panel">
      <header class="panel-head">
        <div>
          <h3>缓存条目目录</h3>
          <p class="page-desc">每个缓存键只暴露一个完整版本；旧完整结果带自身版本标识继续可见，不回填新版本。</p>
        </div>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>缓存键</th>
            <th>目标查询</th>
            <th>依赖数据集</th>
            <th>数据版本</th>
            <th>剩余秒数</th>
            <th>条目状态</th>
            <th>失效依据</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in catalog.entries" :key="`${entry.cacheKey}:${entry.createdAt}`">
            <td>{{ entry.cacheKey }}</td>
            <td>{{ entry.queryCode }}</td>
            <td>{{ entry.datasetCode }}</td>
            <td>v{{ entry.datasetVersion }}<span v-if="entry.stale">（旧版续服）</span></td>
            <td>{{ remainSeconds(entry) }}</td>
            <td>{{ entryStatusText(entry) }}</td>
            <td>{{ entry.invalidatedReason ?? '—' }}</td>
            <td class="row-actions">
              <template v-if="entry.status === 'active'">
                <button class="link" type="button" @click="readEntry(entry)">读取命中</button>
                <button class="link" type="button" @click="retryEntry(entry)">并发重试</button>
                <button class="link" type="button" @click="refreshEntry(entry)">刷新</button>
              </template>
              <span v-else>—</span>
            </td>
          </tr>
          <tr v-if="!catalog.entries.length">
            <td colspan="8" class="empty-state">暂无缓存条目，启用缓存策略后自动登记</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="cache-panel">
      <header class="panel-head">
        <div>
          <h3>缓存命中结果字段明细</h3>
          <p class="page-desc">命中查询缓存后形成，缓存策略与数据版本随结果归档；并发重试只保留一份依据，刷新页面后仍可回看。</p>
        </div>
        <div class="page-actions">
          <button class="btn" type="button" @click="exportHitDetails">导出缓存命中结果字段明细</button>
        </div>
      </header>
      <div class="filter-bar">
        <label class="filter-item">
          <span>按目标查询查看（失效与命中明细只对受影响查询可见）</span>
          <select v-model="detailQueryFilter">
            <option value="">全部查询</option>
            <option v-for="code in queryOptions" :key="code" :value="code">{{ code }}</option>
          </select>
        </label>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in detailColumns" :key="column">{{ column }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in filteredDetailRows" :key="item.id">
            <td v-for="column in detailColumns" :key="column">{{ item.row[column] }}</td>
          </tr>
          <tr v-if="!filteredDetailRows.length">
            <td :colspan="detailColumns.length" class="empty-state">暂无命中明细，可先在条目目录里「读取命中」</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="cache-panel">
      <header class="panel-head">
        <div>
          <h3>失效与冲突判定依据</h3>
          <p class="page-desc">依赖版本与过期时间同时到期时只产生一次失效；冲突判定保留依据，两种处理路径都可评估。</p>
        </div>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>触发</th>
            <th>数据集版本</th>
            <th>受影响查询</th>
            <th>清理条目</th>
            <th>续服条目</th>
            <th>判定依据</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="event in filteredInvalidations" :key="event.id">
            <td>{{ formatCacheTime(event.at) }}</td>
            <td>{{ triggerText(event.trigger) }}</td>
            <td>{{ event.datasetCode }} v{{ event.fromVersion }}→v{{ event.toVersion }}</td>
            <td>{{ event.affectedQueries.join('、') || '—' }}</td>
            <td>{{ event.clearedKeys.join('、') || '—' }}</td>
            <td>{{ event.staleKeys.join('、') || '—' }}</td>
            <td>{{ event.basis }}</td>
          </tr>
          <tr v-if="!filteredInvalidations.length">
            <td colspan="7" class="empty-state">暂无失效事件</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条查询缓存记录</span>
      <span v-if="infoMessage" class="info-text">{{ infoMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import {
  CACHE_HIT_DETAIL_COLUMNS,
  adjustCachePolicyTtl,
  cacheCatalogView,
  cacheHitDetailRow,
  downloadCacheHitDetails,
  downloadEntries,
  formatCacheTime,
  listCacheHitDetails,
  listCacheInvalidations,
  listEntries,
  moduleMeta,
  readQueryCache,
  refreshCacheEntry,
  retryQueryCache,
  runAction as applyAction,
  setCacheConflictStrategy,
  upgradeDatasetVersion,
} from '@/api/local-service'
import type {
  CacheCatalogView,
  CacheConflictStrategy,
  CacheEntry,
  CacheHitDetail,
  CacheInvalidationEvent,
  EntryRow,
} from '@/data/types'

const meta = moduleMeta('cache')
const columns = ["策略编号", "目标查询", "缓存键规则", "过期秒数", "刷新触发", "命中率阈值", "最大条目数", "淘汰算法"]
const actions = ["提交校验", "启用缓存", "停用缓存"]
const statuses = ["草稿", "待校验", "已启用", "已停用"]
const stats = [{"label": "缓存策略总数", "value": 0}, {"label": "已启用策略", "value": 0}, {"label": "待校验策略", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const catalog = ref<CacheCatalogView>({
  datasetVersions: {},
  entries: [],
  hits: 0,
  misses: 0,
  hitRate: 0,
  invalidatedCount: 0,
  conflictStrategy: 'switch-new',
})
const details = ref<CacheHitDetail[]>([])
const invalidations = ref<CacheInvalidationEvent[]>([])
const detailQueryFilter = ref('')
const conflictStrategy = ref<CacheConflictStrategy>('switch-new')
const ttlPolicyCode = ref('CACH-0003')
const ttlSecondsInput = ref('600')
const nowTick = ref(Date.now())

const detailColumns = CACHE_HIT_DETAIL_COLUMNS

const TRIGGER_LABELS: Record<string, string> = {
  'dataset-version': '依赖版本失效',
  'ttl-expiry': 'TTL 到期',
  conflict: '升版+TTL 冲突',
  'manual-refresh': '手动刷新',
}

const hitRateText = computed(() => `${(catalog.value.hitRate * 100).toFixed(0)}%`)
const activeEntryCount = computed(
  () => catalog.value.entries.filter((entry) => entry.status === 'active').length,
)
const datasetVersionList = computed(() =>
  Object.entries(catalog.value.datasetVersions)
    .map(([code, version]) => ({ code, version }))
    .sort((a, b) => a.code.localeCompare(b.code)),
)
const queryOptions = computed(() =>
  [...new Set(catalog.value.entries.map((entry) => entry.queryCode))].sort(),
)
const filteredDetails = computed(() =>
  detailQueryFilter.value
    ? details.value.filter((item) => item.queryCode === detailQueryFilter.value)
    : details.value,
)
// 表格与导出共用同一份列定义与行映射，复核时不会错位
const filteredDetailRows = computed(() =>
  filteredDetails.value.map((item) => ({ id: item.id, row: cacheHitDetailRow(item) })),
)
const filteredInvalidations = computed(() =>
  detailQueryFilter.value
    ? invalidations.value.filter((item) => item.affectedQueries.includes(detailQueryFilter.value))
    : invalidations.value,
)

function triggerText(trigger: string): string {
  return TRIGGER_LABELS[trigger] ?? trigger
}

function remainSeconds(entry: CacheEntry): number {
  return Math.max(0, Math.ceil((entry.expiresAt - nowTick.value) / 1000))
}

function entryStatusText(entry: CacheEntry): string {
  if (entry.status === 'invalidated') {
    return '已失效'
  }
  if (entry.stale) {
    return '旧版续服'
  }
  if (remainSeconds(entry) === 0) {
    return '已到期待清理'
  }
  return '生效'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function exportHitDetails() {
  downloadCacheHitDetails(detailQueryFilter.value || undefined)
  infoMessage.value = '缓存命中结果字段明细已写出下游文件，列与页面明细表一致'
}

function openCreate() {
  errorMessage.value = '缓存策略登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  reload()
}

function upgradeDataset(code: string) {
  errorMessage.value = ''
  const event = upgradeDatasetVersion(code)
  infoMessage.value = `${event.datasetCode} 已升版 v${event.fromVersion}→v${event.toVersion}：${event.basis}`
  reload()
}

function readEntry(entry: CacheEntry) {
  errorMessage.value = ''
  const result = readQueryCache(entry.queryCode)
  infoMessage.value = result.message
  reload()
}

function retryEntry(entry: CacheEntry) {
  errorMessage.value = ''
  const result = retryQueryCache(entry.queryCode)
  infoMessage.value = result.message
  reload()
}

function refreshEntry(entry: CacheEntry) {
  errorMessage.value = ''
  const result = refreshCacheEntry(entry.cacheKey)
  infoMessage.value = result.message
  reload()
}

function applyStrategy() {
  setCacheConflictStrategy(conflictStrategy.value)
  infoMessage.value =
    conflictStrategy.value === 'serve-stale'
      ? '冲突策略已切到「旧版续服」：旧完整结果带版本标识继续可见，不回填新版本'
      : '冲突策略已切到「立即切到新版本」：冲突条目只失效一次'
  reload()
}

function applyTtl() {
  errorMessage.value = ''
  const result = adjustCachePolicyTtl(ttlPolicyCode.value.trim(), Number(ttlSecondsInput.value))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  reload()
}

function reloadCachePanels() {
  catalog.value = cacheCatalogView()
  details.value = listCacheHitDetails()
  invalidations.value = listCacheInvalidations()
  conflictStrategy.value = catalog.value.conflictStrategy
  nowTick.value = Date.now()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    reloadCachePanels()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '查询缓存列表读取失败'
  }
}

let timer: number | undefined

onMounted(() => {
  reload()
  timer = window.setInterval(() => {
    nowTick.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (timer !== undefined) {
    window.clearInterval(timer)
  }
})
</script>
