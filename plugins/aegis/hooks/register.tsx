import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { ModelId, RouterChoice, RouteState } from '../types'
import {
  FABLE_DOWN_MS,
  MODEL_LABELS,
  MODEL_ORDER,
  ROUTER_SYSTEM,
  ROUTING_TABLE,
  SPINNER_FRAMES,
  TIER_TAG,
  demoteFable,
  fallbackRoute,
  finalizeRoute,
  formatTokens,
  isContinuation,
  parseDecision,
  routerModelFor,
  routerPrompt,
} from './routing'
import type { HistoryLine, Route } from './routing'

const PANE = 'aegis'
const FRAME_MS = 110
const ROUTER_TIMEOUT_MS = 20_000
const ROUTER_MAX_TOKENS = 2048

const FABLE = ROUTING_TABLE.FRONTIER

const IDLE: RouteState = {
  phase: 'idle',
  turns: 0,
  routerCalls: 0,
  routerTokens: 0,
}

const route = atom({ plugin: 'aegis', key: 'route' } as const, IDLE, { shape: 'route-2' })
const frame = atom({ plugin: 'aegis', key: 'frame' } as const, 0)
const enabled = atom({ plugin: 'aegis', key: 'enabled' } as const, true)
const fableDownUntil = atom({ plugin: 'aegis', key: 'fableDownUntil' } as const, 0)
const routerOverride = atom({ plugin: 'aegis', key: 'router' } as const, 'default')

const patch =
  (fields: Partial<RouteState>) =>
  (r: RouteState): RouteState => ({ ...r, ...fields })

const configuredRouter = (options: PluginOptions): RouterChoice =>
  options.router === 'fable' ? 'fable' : 'opus'

const resolveRouter = async ($: EngineInterface, options: PluginOptions): Promise<ModelId> => {
  const override = await read($, routerOverride)
  return routerModelFor(override === 'default' ? configuredRouter(options) : override)
}

let spinner: Timer | undefined

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
        reason: r.reason ?? '',
        source: r.source ?? 'router',
      }
    : undefined

const activate = async ($: EngineInterface, chosen: Route, extra: Partial<RouteState> = {}): Promise<void> => {
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
    void $.ui.open({ id: PANE, title: 'Aegis' })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    stopSpinner()
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
      const model = await resolveRouter($, options)
      return { text: `Aegis router: ${MODEL_LABELS[model]}${arg === 'default' ? ' (from settings)' : ''}.` }
    }
    const r = await read($, route)
    const routerModel = await resolveRouter($, options)
    const downUntil = await read($, fableDownUntil)
    const down = (await $.clock.now()) < downUntil
    const last = r.model
      ? `${r.tier} -> ${MODEL_LABELS[r.model]} @ ${r.effort} (${r.source}${r.reason ? `: ${r.reason}` : ''})`
      : 'none yet'
    return {
      text: [
        `Aegis: ${(await read($, enabled)) ? 'on' : 'off'}; router ${MODEL_LABELS[routerModel]}; ${r.turns} turns; router spend ${formatTokens(r.routerTokens)} tokens over ${r.routerCalls} calls.`,
        `Last route: ${last}.`,
        ...(down ? [`Fable unavailable until ${new Date(downUntil).toISOString().slice(11, 16)} UTC.`] : []),
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
        await activate($, finalizeRoute({ ...prior, source: 'sticky', reason: 'follow-up; kept previous route' }))
      } else {
        let routerModel = await resolveRouter($, options)
        if (routerModel === FABLE && now < (await read($, fableDownUntil))) routerModel = ROUTING_TABLE.COMPLEX
        await update($, route, patch({ phase: 'routing', routerModel }))
        startSpinner($)

        const history = await recentHistory($)
        const ask = async (model: ModelId) => {
          try {
            return await $.model.complete({
              model,
              system: [{ text: ROUTER_SYSTEM, cache: true }],
              prompt: routerPrompt({ text: e.text, history, current: prior?.model }),
              maxTokens: ROUTER_MAX_TOKENS,
              effort: 'low',
              timeoutMs: ROUTER_TIMEOUT_MS,
            })
          } catch {
            return undefined // engine refusal (e.g. blocked model) counts as an outage
          }
        }
        // Only a provider error is an outage; aborted (timeout or Esc), empty or unparseable replies are not.
        const isOutage = (r: Awaited<ReturnType<typeof ask>>) => !r || (!r.isAnswered && r.reason === 'api-error')
        let reply = await ask(routerModel)
        if (routerModel === FABLE && isOutage(reply)) {
          await update($, fableDownUntil, () => now + FABLE_DOWN_MS)
          routerModel = ROUTING_TABLE.COMPLEX
          await update($, route, patch({ routerModel }))
          reply = await ask(routerModel)
        }
        const elapsed = (await $.clock.now()) - now
        const parsed = reply?.isAnswered ? parseDecision(reply.text) : undefined
        const decision = parsed && now < (await read($, fableDownUntil)) ? demoteFable(parsed) : parsed
        const spent = reply
          ? reply.usage.input_tokens + reply.usage.output_tokens + reply.usage.cache_read_input_tokens + reply.usage.cache_creation_input_tokens
          : 0
        const chosen = decision
          ? finalizeRoute({ ...decision, source: 'router' })
          : fallbackRoute(e.text)
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

    return yield* next({ ...e, model: current.model, effort: current.effort })
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
    const routerModel = r.routerModel ?? (await resolveRouter($, options))
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
            const label = MODEL_LABELS[model]
            return (
              <Box key={model} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text color={isActive ? 'success' : 'inactive'}>{isActive ? glyph : '·'}</Text>
                  <Text color={isActive ? 'success' : 'text'} bold={isActive}>
                    {label}
                  </Text>
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

        {r.phase === 'active' && r.source !== 'router' && (
          <Box flexDirection="column">
            {r.source === 'sticky' && <Text dimColor>Follow-up: kept previous route, no router call</Text>}
            {r.source === 'fallback' && <Text color="warning">Router unavailable; heuristic route</Text>}
          </Box>
        )}
      </Box>
    )
  })
}
