import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { RouteState } from '../types'
import {
  CLASSIFIER_SYSTEM,
  FABLE_DEADLINE_UTC_MS,
  GATEKEEPER_MODEL,
  MODEL_LABELS,
  MODEL_ORDER,
  SPINNER_FRAMES,
  TIER_TAG,
  classifierPrompt,
  enforceDeadline,
  isFableExpired,
  parseTier,
  resolveRoute,
} from './routing'

const PANE = 'aegis'
const FRAME_MS = 110
const CLASSIFY_TIMEOUT_MS = 8000
const MAX_TIMER_MS = 2_147_483_647

const IDLE: RouteState = { phase: 'idle', demoted: false, classifierFailed: false, turns: 0 }

const route = atom({ plugin: 'aegis', key: 'route' } as const, IDLE, { shape: 'route-1' })
const frame = atom({ plugin: 'aegis', key: 'frame' } as const, 0)
const enabled = atom({ plugin: 'aegis', key: 'enabled' } as const, true)
const fableExpired = atom({ plugin: 'aegis', key: 'fableExpired' } as const, false)

const patch =
  (fields: Partial<RouteState>) =>
  (r: RouteState): RouteState => ({ ...r, ...fields })

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'aegis',
      description: 'Aegis model router: on | off | status | pane',
      argumentHint: '[on|off|status|pane]',
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
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await update($, enabled, () => arg === 'on')
      return { text: `Aegis routing ${arg}.` }
    }
    if (arg === 'pane') {
      await $.ui.open({ id: PANE, title: 'Aegis' })
      return { text: 'Aegis pane opened.' }
    }
    const r = await read($, route)
    const isOn = await read($, enabled)
    const expired = await read($, fableExpired)
    const last = r.model ? `${r.tier} -> ${MODEL_LABELS[r.model]} @ ${r.effort}` : 'none yet'
    return {
      text: [
        `Aegis: ${isOn ? 'on' : 'off'}; ${r.turns} turns routed; last route: ${last}.`,
        `Fable 5.2: ${expired ? 'limit expired, FRONTIER routes to Opus 5.5' : `available until ${new Date(FABLE_DEADLINE_UTC_MS).toISOString()}`}.`,
      ].join('\n'),
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || e.turnId !== undefined || !(await read($, enabled))) {
      return next(e)
    }

    await update($, route, patch({ phase: 'classifying' }))
    startSpinner($)

    try {
      const reply = await $.model.complete({
        model: GATEKEEPER_MODEL,
        system: CLASSIFIER_SYSTEM,
        prompt: classifierPrompt(e.text),
        maxTokens: 256,
        effort: 'low',
        timeoutMs: CLASSIFY_TIMEOUT_MS,
      })
      const parsed = reply.isAnswered ? parseTier(reply.text) : undefined
      const now = await $.clock.now()
      const chosen = resolveRoute(parsed ?? 'STANDARD', e.text, now)
      if (chosen.demoted) await update($, fableExpired, () => true)
      await update(
        $,
        route,
        patch({
          phase: 'active',
          tier: chosen.tier,
          model: chosen.model,
          effort: chosen.effort,
          demoted: chosen.demoted,
          classifierFailed: parsed === undefined,
        }),
      )
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
    if (r.phase !== 'active' || !r.tier || !r.model || !r.effort) return yield* next(e)

    const live = enforceDeadline(
      { tier: r.tier, model: r.model, effort: r.effort, demoted: r.demoted },
      await $.clock.now(),
    )
    if (live.model !== r.model) {
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
    const glyph = SPINNER_FRAMES[tick % SPINNER_FRAMES.length]

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>Aegis router</Text>
          <Text dimColor>{isOn ? `${r.turns} turns routed` : 'Routing off. /aegis on'}</Text>
        </Box>

        <Box flexDirection="column">
          <Text color={r.phase === 'classifying' ? 'claude' : 'inactive'}>
            {r.phase === 'classifying' ? glyph : '·'} Gatekeeper {r.phase === 'classifying' ? 'classifying...' : 'Haiku 5.5'}
          </Text>
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

        {(r.demoted || r.classifierFailed) && r.phase !== 'idle' && (
          <Box flexDirection="column">
            {r.demoted && <Text color="warning">Frontier demoted to Opus 5.5</Text>}
            {r.classifierFailed && <Text color="warning">Gatekeeper unsure; defaulted to Standard</Text>}
          </Box>
        )}
      </Box>
    )
  })
}
