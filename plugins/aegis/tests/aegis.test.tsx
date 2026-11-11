import { describe, expect, mock, test } from 'claude-code/testing'
import type { ModelCompleteInput, On, TurnStepInput } from 'claude-code'

import {
  FABLE_DEADLINE_UTC_MS,
  calculate_effort,
  clampEffort,
  countCodeBlocks,
  enforceDeadline,
  fallbackRoute,
  finalizeRoute,
  isContinuation,
  isFableExpired,
  parseDecision,
  routerModelFor,
  routerPrompt,
} from '../hooks/routing'

const BEFORE = Date.UTC(2026, 10, 11, 12, 0, 0)
const AFTER = FABLE_DEADLINE_UTC_MS + 1

const PANE = {
  plugin: 'aegis',
  component: 'Pane',
  requestId: 'aegis',
  props: {
    title: 'Aegis',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const USAGE = { input_tokens: 900, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type World = { steps: TurnStepInput[]; routerCalls: ModelCompleteInput[] }

const engine = (on: On, reply: string | null): World => {
  const world: World = { steps: [], routerCalls: [] }
  on('command.register', () => ({ value: { command: 'aegis' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({
    value: [{ role: 'user', text: 'refactor the scheduler', toolUses: [] }],
  }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('model.complete', (_, e) => {
    world.routerCalls.push(e)
    return {
      value:
        reply === null
          ? { isAnswered: false, reason: 'empty-reply', usage: USAGE }
          : { isAnswered: true, text: reply, usage: USAGE },
    }
  })
  on('turn.step', async function* (_, e) {
    world.steps.push(e)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return world
}

const decide = (model: string, effort: string, tier = '', reason = 'test') =>
  JSON.stringify({ ...(tier ? { tier } : {}), model, effort, reason })

const drain = async <C, R>(stream: AsyncGenerator<C, R>): Promise<R> => {
  for (;;) {
    const r = await stream.next()
    if (r.done) return r.value
  }
}

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

const step = (turnId: string, index = 0): TurnStepInput => ({
  turnId,
  index,
  model: 'claude-opus-5-5',
  effort: 'high',
  messageCount: 1,
})

const done = (turnId: string) => ({ turnId, answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' as const })

describe('routing core', () => {
  test('deadline is Nov 16 2026 23:59:59.999 PST', async () => {
    expect(new Date(FABLE_DEADLINE_UTC_MS).toISOString()).toBe('2026-11-17T07:59:59.999Z')
    expect(isFableExpired(FABLE_DEADLINE_UTC_MS)).toBe(false)
    expect(isFableExpired(AFTER)).toBe(true)
  })

  test('effort is capped per model; Fable never above medium', async () => {
    expect(clampEffort('claude-fable-5-2', 'xhigh')).toBe('medium')
    expect(clampEffort('claude-fable-5-2', 'high')).toBe('medium')
    expect(clampEffort('claude-fable-5-2', 'low')).toBe('low')
    expect(clampEffort('claude-opus-5-5', 'xhigh')).toBe('high')
    expect(clampEffort('claude-sonnet-5-5', 'xhigh')).toBe('xhigh')
    expect(clampEffort('claude-haiku-5-5', 'xhigh')).toBe('high')
  })

  test('a Fable route after the deadline becomes Opus, demoted', async () => {
    const draft = { tier: 'FRONTIER', model: 'claude-fable-5-2', effort: 'medium', reason: '', source: 'router' } as const
    expect(finalizeRoute(draft, BEFORE).model).toBe('claude-fable-5-2')
    const after = finalizeRoute(draft, AFTER)
    expect(after.model).toBe('claude-opus-5-5')
    expect(after.demoted).toBe(true)
    expect(enforceDeadline(finalizeRoute(draft, BEFORE), AFTER).model).toBe('claude-opus-5-5')
  })

  test('router model falls back from Fable to Opus after the deadline', async () => {
    expect(routerModelFor('fable', BEFORE)).toBe('claude-fable-5-2')
    expect(routerModelFor('fable', AFTER)).toBe('claude-opus-5-5')
    expect(routerModelFor('opus', AFTER)).toBe('claude-opus-5-5')
  })

  test('decisions parse through prose, fences, aliases and missing fields', async () => {
    expect(parseDecision('```json\n{"tier":"COMPLEX","model":"opus","effort":"high","reason":"cross-module"}\n```')).toEqual({
      tier: 'COMPLEX',
      model: 'claude-opus-5-5',
      effort: 'high',
      reason: 'cross-module',
    })
    expect(parseDecision('{"model":"Claude Sonnet 5.5","effort":"MAX"}')?.model).toBe('claude-sonnet-5-5')
    expect(parseDecision('{"model":"Claude Sonnet 5.5","effort":"MAX"}')?.effort).toBe('xhigh')
    expect(parseDecision('{"tier":"simple"}')?.model).toBe('claude-haiku-5-5')
    expect(parseDecision('{"tier":"simple"}')?.effort).toBe('medium')
    expect(parseDecision('{"model":"gpt"}')).toBe(undefined)
    expect(parseDecision('no json here')).toBe(undefined)
    expect(parseDecision('{broken')).toBe(undefined)
  })

  test('short acknowledgements count as follow-ups, real requests do not', async () => {
    for (const t of ['yes', 'Continue.', 'go ahead', 'ok!', 'do it', 'LGTM']) expect(isContinuation(t)).toBe(true)
    for (const t of ['yes but use redis', 'continue with the auth module', 'fix it']) expect(isContinuation(t)).toBe(false)
  })

  test('router prompt carries state, recent history and the request', async () => {
    const p = routerPrompt({
      text: 'add retries',
      history: [{ role: 'assistant', text: 'I updated client.ts', tools: ['Edit', 'Edit', 'Bash'] }],
      current: 'claude-sonnet-5-5',
      fableAvailable: false,
    })
    expect(p).toContain('current_model: sonnet')
    expect(p).toContain('fable: unavailable')
    expect(p).toContain('assistant (tools: Edit, Bash): I updated client.ts')
    expect(p).toContain('<request>\nadd retries\n</request>')
  })

  test('fallback is Sonnet with heuristic effort', async () => {
    const r = fallbackRoute('x'.repeat(5000), BEFORE)
    expect(r.model).toBe('claude-sonnet-5-5')
    expect(r.effort).toBe('high')
    expect(r.source).toBe('fallback')
    expect(calculate_effort(100, 0)).toBe('low')
    expect(countCodeBlocks('```ts\na\n```\n~~~\nb\n~~~')).toBe(2)
  })
})

describe('session flow', () => {
  test('Opus routes by default and its decision drives model and effort', async ($, on) => {
    mock.clock(on, { now: BEFORE })
    const world = engine(on, decide('sonnet', 'xhigh', 'STANDARD', 'long agentic coding task'))

    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.prompt.submit(typed('Implement retry with backoff across the HTTP client and add tests.'))
    await drain($.turn.step(step('t1')))

    expect(world.routerCalls[0]?.model).toBe('claude-opus-5-5')
    expect(world.routerCalls[0]?.effort).toBe('low')
    expect(world.routerCalls[0]?.prompt).toContain('refactor the scheduler')
    expect(world.steps[0]?.model).toBe('claude-sonnet-5-5')
    expect(world.steps[0]?.effort).toBe('xhigh')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ type: 'Text', text: /Active/ }))?.text).toBe('  [Standard] Sonnet 5.5 Active... effort xhigh')
      expect((await ui.find({ type: 'Text', text: /^Router/ }))?.text).toBe('Router · Opus 5.5')
      expect((await ui.find({ type: 'Text', text: /long agentic/ }))?.text).toBe('  long agentic coding task')
      await ui.unmount()
    }
  })

  test('a Fable pick runs at medium at most', async ($, on) => {
    mock.clock(on, { now: BEFORE })
    const world = engine(on, decide('fable', 'xhigh', 'FRONTIER'))

    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.prompt.submit(typed('Design a novel consensus protocol.'))
    await drain($.turn.step(step('t1')))

    expect(world.steps[0]?.model).toBe('claude-fable-5-2')
    expect(world.steps[0]?.effort).toBe('medium')
  })

  test('after the deadline a Fable pick runs on Opus and Fable is grayed out', async ($, on) => {
    mock.clock(on, { now: AFTER })
    const world = engine(on, decide('fable', 'medium', 'FRONTIER'))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.prompt.submit(typed('Design a novel consensus protocol.'))
    await drain($.turn.step(step('t1')))

    expect(world.routerCalls[0]?.prompt).toContain('fable: unavailable')
    expect(world.steps[0]?.model).toBe('claude-opus-5-5')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /Limit Expired/ }))?.text).toBe(' Limit Expired ')
    expect((await ui.find({ type: 'Text', text: /demoted/ }))?.text).toBe('Frontier demoted to Opus 5.5')
    await ui.unmount()
  })

  test('the deadline passing mid-turn moves Fable to Opus', async ($, on) => {
    const clock = mock.clock(on, { now: FABLE_DEADLINE_UTC_MS - 60_000 })
    const world = engine(on, decide('fable', 'medium'))

    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.prompt.submit(typed('Long autonomous refactor.'))
    await drain($.turn.step(step('t1', 0)))
    await clock.advance(120_000)
    await drain($.turn.step(step('t1', 1)))

    expect(world.steps.map(s => s.model)).toEqual(['claude-fable-5-2', 'claude-opus-5-5'])
  })

  test('the router setting picks Fable as dispatcher, and Opus after the deadline', async ($, on) => {
    mock.clock(on, { now: BEFORE })
    const world = engine(on, decide('haiku', 'low'))

    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.command.run({ command: 'aegis', args: 'router fable', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    await $.prompt.submit(typed('what does this regex match'))
    expect(world.routerCalls[0]?.model).toBe('claude-fable-5-2')
  })

  test('userConfig router=fable is honoured', { options: { router: 'fable' } }, async ($, on) => {
    mock.clock(on, { now: AFTER })
    const world = engine(on, decide('haiku', 'low'))

    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.prompt.submit(typed('what does this regex match'))
    expect(world.routerCalls[0]?.model).toBe('claude-opus-5-5')
  })

  test('a follow-up reuses the last route without a router call', async ($, on) => {
    mock.clock(on, { now: BEFORE })
    const world = engine(on, decide('opus', 'high', 'COMPLEX'))

    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.prompt.submit(typed('Redesign the cache invalidation layer.'))
    await drain($.turn.step(step('t1')))
    await $.turn.complete(done('t1'))
    await $.prompt.submit(typed('yes, go ahead'))
    await $.prompt.submit(typed('go ahead'))
    await drain($.turn.step(step('t2')))

    expect(world.routerCalls.length).toBe(2)
    expect(world.steps.map(s => [s.model, s.effort])).toEqual([
      ['claude-opus-5-5', 'high'],
      ['claude-opus-5-5', 'high'],
    ])
  })

  test('an unusable router reply falls back to Sonnet', async ($, on) => {
    mock.clock(on, { now: BEFORE })
    const world = engine(on, null)

    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.prompt.submit(typed('fix the flaky test in auth.spec.ts'))
    await drain($.turn.step(step('t1')))

    expect(world.steps[0]?.model).toBe('claude-sonnet-5-5')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.find({ type: 'Text', text: /^Router unavailable/ }))?.text).toBe('Router unavailable; heuristic route')
    await ui.unmount()
  })

  test('subagent steps and later idle turns are left alone', async ($, on) => {
    mock.clock(on, { now: BEFORE })
    const world = engine(on, decide('haiku', 'low'))

    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.prompt.submit(typed('rename foo to bar'))
    await drain($.turn.step({ ...step('t1'), agentId: 'a1' }))
    await $.turn.complete(done('t1'))
    await drain($.turn.step(step('t2')))

    expect(world.steps.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
  })

  test('/aegis off disables routing and the router call', async ($, on) => {
    mock.clock(on, { now: BEFORE })
    const world = engine(on, decide('fable', 'medium'))

    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.command.run({ command: 'aegis', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    await $.prompt.submit(typed('Design a novel consensus protocol.'))
    await drain($.turn.step(step('t1')))

    expect(world.routerCalls.length).toBe(0)
    expect(world.steps[0]?.model).toBe('claude-opus-5-5')
  })
})
