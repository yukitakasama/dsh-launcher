<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Message } from '@arco-design/web-vue'
import { api } from '@/api'
import type { ProviderRoute } from '@/api/types'
import { PROVIDER_TEMPLATE_PLACEHOLDER } from '@/api/types'
import { routeToEnvName } from '@/utils/envName'
import { useLauncherStore } from '@/stores/launcher'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ 'update:visible': [boolean] }>()

const { t } = useI18n()
const store = useLauncherStore()

interface FillItem {
  profile: string
  homeId: string
  route: ProviderRoute
  /** sha256 of the profile patch at scan time; every write echoes it. */
  patchHash: string
  envVar: string
  key: string
  done: boolean
  error: string | null
}

const loading = ref(false)
const busy = ref(false)
const items = ref<FillItem[]>([])

const instanceId = computed(() => store.pendingProviderTemplateFill?.instanceId ?? '')

async function scan() {
  if (!instanceId.value) return
  loading.value = true
  items.value = []
  try {
    // Make sure the freshly imported instance (and its home) is in the store.
    await store.refreshInstances()
    const inst = store.instanceById(instanceId.value)
    if (!inst) {
      Message.warning(t('providerTemplate.instanceMissing'))
      return
    }
    const profiles = await api.listProfiles(inst.home_id)
    const found: FillItem[] = []
    for (const profile of profiles) {
      const list = await api.listProviderRoutes(inst.home_id, profile)
      for (const route of list.routes) {
        if (route.apiKeyEnv === PROVIDER_TEMPLATE_PLACEHOLDER) {
          found.push({
            profile,
            homeId: inst.home_id,
            route,
            patchHash: list.hash,
            envVar: routeToEnvName(route.route),
            key: '',
            done: false,
            error: null,
          })
        }
      }
    }
    items.value = found
    // Nothing to fill — the pack either carried no templates or they already
    // had real keys. Close quietly so the user isn't shown an empty dialog.
    if (found.length === 0) {
      close()
    }
  } catch (e) {
    Message.error(String(e))
  } finally {
    loading.value = false
  }
}

watch(
  () => props.visible,
  (v) => {
    if (v) void scan()
  },
)

async function applyAll() {
  if (!instanceId.value) return
  busy.value = true
  try {
    let applied = 0
    let firstError: string | null = null
    // Credential refs share one hash guard per DSH_HOME; chain it across
    // writes and refresh it when the route write lands first.
    let credHash = ''
    for (const item of items.value) {
      if (item.done) continue
      item.error = null
      if (!item.envVar.trim() || !item.key.trim()) {
        item.error = t('providerTemplate.fieldRequired')
        firstError = firstError ?? item.error
        continue
      }
      try {
        if (!credHash) {
          credHash = (await api.listCredentialRefs(item.homeId, instanceId.value)).hash
        }
        // 1. Point the route at the real env name (replaces the placeholder).
        const saved = await api.saveProviderRoute(
          item.homeId,
          item.profile,
          { ...item.route, apiKeyEnv: item.envVar.trim() },
          item.route.route,
          item.patchHash,
        )
        item.patchHash = saved.hash
        // 2. Store the key under that name in the credential refs.
        const refs = await api.setCredentialRef(
          item.homeId,
          instanceId.value,
          item.envVar.trim(),
          item.key.trim(),
          credHash,
        )
        credHash = refs.hash
        item.done = true
        applied += 1
      } catch (e) {
        const msg = String(e)
        item.error = msg
        firstError = firstError ?? msg
        if (msg.startsWith('STALE_HASH')) {
          // Someone edited the config meanwhile: refresh the hashes and let
          // the remaining items continue against the fresh state.
          Message.warning(t('providerTemplate.stale'))
          credHash = ''
          await scan()
          return
        }
      }
    }
    if (applied > 0) {
      Message.success(t('providerTemplate.done', { count: applied }))
      await runSelfCheck()
    }
    if (firstError) {
      Message.error(t('providerTemplate.partialError', { msg: firstError }))
    } else {
      close()
    }
  } finally {
    busy.value = false
  }
}

function close() {
  store.pendingProviderTemplateFill = null
  emit('update:visible', false)
}

/** issue #86 follow-up: after a successful fill, surface the pre-launch
 * self-check so the user immediately sees whether each route is ready.
 * Best-effort — a check failure never blocks the fill flow. */
async function runSelfCheck() {
  const homeId = items.value[0]?.homeId
  if (!homeId) return
  const affected = [...new Set(items.value.filter((i) => i.done).map((i) => i.profile))]
  try {
    let ok = 0
    let issues = 0
    for (const profile of affected) {
      const report = await api.checkProviderRoutes(homeId, instanceId.value, profile)
      for (const r of report) {
        if (r.status === 'ok') ok += 1
        else issues += 1
      }
    }
    if (issues > 0) {
      Message.warning(t('providerTemplate.checkIssues', { ok, issues }))
    } else if (ok > 0) {
      Message.info(t('providerTemplate.checkOk', { ok }))
    }
  } catch {
    // Self-check is informational only; ignore failures.
  }
}
</script>

<template>
  <a-modal
    :visible="visible"
    :title="t('providerTemplate.title')"
    :ok-loading="busy"
    :ok-text="t('providerTemplate.apply')"
    :cancel-text="t('providerTemplate.skip')"
    :ok-button-props="{ disabled: loading || items.length === 0 }"
    @ok="applyAll"
    @cancel="close"
  >
    <a-spin :loading="loading">
      <div v-if="items.length" class="ptf-intro">{{ t('providerTemplate.intro') }}</div>
      <div v-for="(item, idx) in items" :key="idx" class="ptf-row">
        <div class="ptf-route">
          <strong>{{ item.route.displayName || item.route.route }}</strong>
          <span class="ptf-profile">（{{ item.profile }}）</span>
        </div>
        <a-form :model="{}" layout="vertical">
          <a-form-item :label="t('providerTemplate.envVar')">
            <a-input
              v-model="item.envVar"
              :placeholder="t('providerTemplate.envVarPlaceholder')"
            />
          </a-form-item>
          <a-form-item :label="t('providerTemplate.key')">
            <a-input-password
              v-model="item.key"
              :placeholder="t('providerTemplate.keyPlaceholder')"
              :disabled="item.done"
            />
          </a-form-item>
        </a-form>
        <a-alert v-if="item.error" type="error" class="ptf-err">{{ item.error }}</a-alert>
        <a-tag v-else-if="item.done" color="green">{{ t('providerTemplate.appliedOne') }}</a-tag>
      </div>
    </a-spin>
  </a-modal>
</template>

<style scoped>
.ptf-intro {
  margin-bottom: 12px;
  color: var(--color-text-2);
}
.ptf-row {
  border-bottom: 1px solid var(--color-border-1);
  padding: 12px 0;
}
.ptf-profile {
  color: var(--color-text-3);
  font-size: 12px;
}
.ptf-err {
  margin-top: 8px;
}
</style>
