import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { ModelId, RouterChoice, RouteState } from '../types'
import {
  FABLE_DEADLINE_UTC_MS,
  MODEL_LABELS,
  MODEL_ORDER,
  ROUTER_SYSTEM,
  SPINNER_FRAMES,
  TIER_TAG,
  enforceDeadline,
  fallbackRoute,
  finalizeRoute,
  formatTokens,
  isContinuation,
  isFableExpired,
  parseDecision,
  routerModelFor,
  routerPrompt,
} from './routing'
import type { HistoryLine, Route } from './routing'

const PANE = 'aegis'
const FRAME_MS = 110
const ROUTER_TIMEOUT_MS = 20_000
const ROUTER_MAX_TOKENS = 2048
const MAX_TIMER_MS = 2_147_483_647

const IDLE: RouteState = {
  phase: 'idle',
  demoted: false,
  turns: 0,
  routerCalls: 0,
  routerTokens: 0,
}

const route = atom({ plugin: 'aegis', key: 'route' } as const, IDLE, { shape: 'route-2' })
const frame = atom({ plugin: 'aegis', key: 'frame' } as const, 0)
const enabled = atom({ plugin: 'aegis', key: 'enabled' } as const, true)
const fableExpired = atom({ plugin: 'aegis', key: 'fableExpired' } as const, false)
const routerOverride = atom({ plugin: 'aegis', key: 'router' } as const, 'default')

const patch =
  (fields: Partial<RouteState>) =>
  (r: RouteState): RouteState => ({ ...r, ...fields })

const configuredRouter = (options: PluginOptions): RouterChoice =>
  options.router === 'fable' ? 'fable' : 'opus'

const resolveRouter = async ($: EngineInterface, options: PluginOptions, now: number): Promise<ModelId> => {
  const override = await read($, routerOverride)
  return routerModelFor(override === 'default' ? configuredRouter(options) : override, now)
}

let spinner: Timer | undefined
let expiryTimer: Timer | undefined

const startSpinner = ($: EngineInterface): void => {
  spinner ??= $.clock.every(FRAME_MS, () => {
    void update($, frame, n => (n + 1) % SPINNER_FRAMES.length)
  })
}

const stopSpinner = (): void => {
  spinner?.cancel()
  spinner = undefined
}

const goIdle = async ($: EngineInterface, countTurn: boolean): Promise<void> => {
  stopSpinner()
  await update($, route, r => patch({ phase: 'idle', turns: r.turns + (countTurn ? 1 : 0) })(r))
}

const armExpiry = async ($: EngineInterface): Promise<void> => {
  expiryTimer?.cancel()
  const now = await $.clock.now()
  if (isFableExpired(now)) {
    await update($, fableExpired, () => true)
    return
  }
  const wait = Math.min(FABLE_DEADLINE_UTC_MS - now + 1, MAX_TIMER_MS)
  expiryTimer = $.clock.after(wait, () => void armExpiry($))
}

const recentHistory = async ($: EngineInterface): Promise<HistoryLine[]> => {
  try {
    const rows = await $.session.messages()
    return rows
      .slice(-12)
      .map(m => ({ role: m.role, text: m.text, tools: m.toolUses.map(t => t.tool) }))
  } catch {
    return []
  }
}

const routeOf = (r: RouteState): Route | undefined =>
  r.tier && r.model && r.effort
    ? {
        tier: r.tier,
        model: r.model,
        effort: r.effort,
        demoted: r.demoted,
        reason: r.reason ?? '',
        source: r.source ?? 'router',
      }
    : undefined

const activate = async ($: EngineInterface, chosen: Route, extra: Partial<RouteState> = {}): Promise<void> => {
  if (chosen.demoted) await update($, fableExpired, () => true)
  await update(
    $,
    route,
    patch({
      phase: 'active',
      tier: chosen.tier,
      model: chosen.model,
      effort: chosen.effort,
      reason: chosen.reason,
      source: chosen.source,
      demoted: chosen.demoted,
      ...extra,
    }),
  )
  startSpinner($)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'aegis',
      description: 'Aegis router: on | off | status | pane | router opus|fable|default',
      argumentHint: '[on|off|status|pane|router <opus|fable|default>]',
    })
    await update($, route, patch({ phase: 'idle' }))
    await armExpiry($)
    void $.ui.open({ id: PANE, title: 'Aegis' })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    stopSpinner()
    expiryTimer?.cancel()
    return next(e)
  })

  on('command.run', { command: 'aegis' }, async ($, e) => {
    const [verb = 'status', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (verb === 'on' || verb === 'off') {
      await update($, enabled, () => verb === 'on')
      return { text: `Aegis routing ${verb}.` }
    }
    if (verb === 'pane') {
      await $.ui.open({ id: PANE, title: 'Aegis' })
      return { text: 'Aegis pane opened.' }
    }
    if (verb === 'router') {
      if (arg !== 'opus' && arg !== 'fable' && arg !== 'default') {
        return { text: 'Usage: /aegis router opus|fable|default' }
      }
      await update($, routerOverride, () => arg)
      const model = await resolveRouter($, options, await $.clock.now())
      return { text: `Aegis router: ${MODEL_LABELS[model]}${arg === 'default' ? ' (from settings)' : ''}.` }
    }
    const r = await read($, route)
    const now = await $.clock.now()
    const routerModel = await resolveRouter($, options, now)
    const last = r.model
      ? `${r.tier} -> ${MODEL_LABELS[r.model]} @ ${r.effort} (${r.source}${r.reason ? `: ${r.reason}` : ''})`
      : 'none yet'
    return {
      text: [
        `Aegis: ${(await read($, enabled)) ? 'on' : 'off'}; router ${MODEL_LABELS[routerModel]}; ${r.turns} turns; router spend ${formatTokens(r.routerTokens)} tokens over ${r.routerCalls} calls.`,
        `Last route: ${last}.`,
        `Fable 5.2: ${isFableExpired(now) ? 'limit expired; routes to Opus 5.5' : `available until ${new Date(FABLE_DEADLINE_UTC_MS).toISOString()}`}.`,
      ].join('\n'),
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || e.turnId !== undefined || !(await read($, enabled))) {
      return next(e)
    }

    try {
      const now = await $.clock.now()
      const prev = await read($, route)
      const prior = routeOf(prev)

      if (prior && isContinuation(e.text)) {
        await activate($, finalizeRoute({ ...prior, source: 'sticky', reason: 'follow-up; kept previous route' }, now))
      } else {
        const routerModel = await resolveRouter($, options, now)
        await update($, route, patch({ phase: 'routing', routerModel }))
        startSpinner($)

        const reply = await $.model.complete({
          model: routerModel,
          system: [{ text: ROUTER_SYSTEM, cache: true }],
          prompt: routerPrompt({
            text: e.text,
            history: await recentHistory($),
            current: prior?.model,
            fableAvailable: !isFableExpired(now),
          }),
          maxTokens: ROUTER_MAX_TOKENS,
          effort: 'low',
          timeoutMs: ROUTER_TIMEOUT_MS,
        })
        const elapsed = (await $.clock.now()) - now
        const decision = reply.isAnswered ? parseDecision(reply.text) : undefined
        const spent = reply.usage.input_tokens + reply.usage.output_tokens + reply.usage.cache_read_input_tokens + reply.usage.cache_creation_input_tokens
        const chosen = decision
          ? finalizeRoute({ ...decision, source: 'router' }, now)
          : fallbackRoute(e.text, now)
        await activate($, chosen, {
          routerModel,
          lastRouterMs: elapsed,
          routerCalls: prev.routerCalls + 1,
          routerTokens: prev.routerTokens + spent,
        })
      }
    } catch {
      await goIdle($, false)
      return next(e)
    }

    const result = await next(e)
    if (result.drop !== undefined) await goIdle($, false)
    return result
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const r = await read($, route)
    const current = routeOf(r)
    if (r.phase !== 'active' || !current) return yield* next(e)

    const live = enforceDeadline(current, await $.clock.now())
    if (live.model !== current.model) {
      await update($, fableExpired, () => true)
      await update($, route, patch({ model: live.model, effort: live.effort, demoted: true }))
    }
    return yield* next({ ...e, model: live.model, effort: live.effort })
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && (await read($, route)).phase !== 'idle') await goIdle($, true)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const r = await read($, route)
    const tick = await read($, frame)
    const isOn = await read($, enabled)
    const expired = await read($, fableExpired)
    const routerModel = r.routerModel ?? (await resolveRouter($, options, await $.clock.now()))
    const glyph = SPINNER_FRAMES[tick % SPINNER_FRAMES.length]
    const routing = r.phase === 'routing'

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>Aegis router</Text>
          <Text dimColor>
            {isOn
              ? `${r.turns} turns · router ${formatTokens(r.routerTokens)} tok${r.lastRouterMs !== undefined ? ` · ${(r.lastRouterMs / 1000).toFixed(1)}s` : ''}`
              : 'Routing off. /aegis on'}
          </Text>
        </Box>

        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text color={routing ? 'claude' : 'inactive'}>{routing ? glyph : '◆'}</Text>
            <Text color={routing ? 'claude' : 'text'} bold={routing}>
              {`Router · ${MODEL_LABELS[routerModel]}`}
            </Text>
          </Box>
          <Text dimColor>{routing ? '  deciding model and effort...' : r.reason ? `  ${r.reason}` : '  waiting for a prompt'}</Text>
        </Box>

        <Box flexDirection="column">
          {MODEL_ORDER.map(model => {
            const isActive = r.phase === 'active' && r.model === model
            const isDead = model === 'claude-fable-5-2' && expired
            const label = MODEL_LABELS[model]
            return (
              <Box key={model} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text color={isActive ? 'success' : 'inactive'}>{isActive ? glyph : '·'}</Text>
                  <Text
                    color={isDead ? 'inactive' : isActive ? 'success' : 'text'}
                    dimColor={isDead}
                    strikethrough={isDead}
                    bold={isActive}
                  >
                    {label}
                  </Text>
                  {isDead && (
                    <Text backgroundColor="warning" color="inverseText">
                      {' Limit Expired '}
                    </Text>
                  )}
                </Box>
                {isActive && r.tier && (
                  <Text color="success" dimColor>
                    {`  [${TIER_TAG[r.tier]}] ${label} Active... effort ${r.effort}`}
                  </Text>
                )}
              </Box>
            )
          })}
        </Box>

        {r.phase === 'active' && (r.demoted || r.source !== 'router') && (
          <Box flexDirection="column">
            {r.demoted && <Text color="warning">Frontier demoted to Opus 5.5</Text>}
            {r.source === 'sticky' && <Text dimColor>Follow-up: kept previous route, no router call</Text>}
            {r.source === 'fallback' && <Text color="warning">Router unavailable; heuristic route</Text>}
          </Box>
        )}
      </Box>
    )
  })
}
