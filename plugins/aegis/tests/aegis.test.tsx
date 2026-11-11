import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, TurnStepInput } from 'claude-code'

import {
  FABLE_DEADLINE_UTC_MS,
  calculate_effort,
  countCodeBlocks,
  effortFor,
  enforceDeadline,
  isFableExpired,
  parseTier,
  resolveRoute,
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
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

const engine = (on: On, label: string | null, steps: TurnStepInput[]): void => {
  on('command.register', () => ({ value: { command: 'aegis' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('model.complete', () => ({
    value:
      label === null
        ? { isAnswered: false, reason: 'empty-reply', usage: USAGE }
        : { isAnswered: true, text: label, usage: USAGE },
  }))
  on('turn.step', async function* (_, e) {
    steps.push(e)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
}

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

describe('routing core', () => {
  test('deadline is Nov 16 2026 23:59:59.999 PST', async () => {
    expect(new Date(FABLE_DEADLINE_UTC_MS).toISOString()).toBe('2026-11-17T07:59:59.999Z')
    expect(isFableExpired(FABLE_DEADLINE_UTC_MS)).toBe(false)
    expect(isFableExpired(FABLE_DEADLINE_UTC_MS + 1)).toBe(true)
  })

  test('FRONTIER routes to Fable before, Opus after', async () => {
    expect(resolveRoute('FRONTIER', 'x', BEFORE).model).toBe('claude-fable-5-2')
    const after = resolveRoute('FRONTIER', 'x', AFTER)
    expect(after.model).toBe('claude-opus-5-5')
    expect(after.demoted).toBe(true)
  })

  test('a Fable route crossing the deadline mid-turn is demoted', async () => {
    const r = resolveRoute('FRONTIER', 'x', BEFORE)
    expect(enforceDeadline(r, BEFORE)).toEqual(r)
    expect(enforceDeadline(r, AFTER).model).toBe('claude-opus-5-5')
  })

  test('Opus and Fable are pinned to medium regardless of weight', async () => {
    const heavy = 'x'.repeat(50_000) + '\n```\na\n```\n'.repeat(10)
    expect(effortFor('claude-fable-5-2', heavy)).toBe('medium')
    expect(effortFor('claude-opus-5-5', heavy)).toBe('medium')
    expect(effortFor('claude-sonnet-5-5', heavy)).toBe('high')
  })

  test('calculate_effort scales with length and code blocks', async () => {
    expect(calculate_effort(100, 0)).toBe('low')
    expect(calculate_effort(100, 1)).toBe('medium')
    expect(calculate_effort(2000, 0)).toBe('medium')
    expect(calculate_effort(500, 3)).toBe('high')
    expect(calculate_effort(5000, 0)).toBe('high')
  })

  test('code fences are counted in pairs', async () => {
    expect(countCodeBlocks('```ts\na\n```\ntext\n~~~\nb\n~~~')).toBe(2)
    expect(countCodeBlocks('```unterminated')).toBe(0)
  })

  test('tier parsing takes the first label named', async () => {
    expect(parseTier('complex')).toBe('COMPLEX')
    expect(parseTier('Label: FRONTIER.')).toBe('FRONTIER')
    expect(parseTier('STANDARD, not COMPLEX')).toBe('STANDARD')
    expect(parseTier('unsure')).toBe(undefined)
  })
})

describe('session flow', () => {
  test('FRONTIER before the deadline runs Fable at medium and draws it active', async ($, on) => {
    mock.clock(on, { now: BEFORE })
    const steps: TurnStepInput[] = []
    engine(on, 'FRONTIER', steps)

    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.prompt.submit(typed('Design a novel consensus protocol.'))
    await drain($.turn.step(step('t1')))

    expect(steps[0]?.model).toBe('claude-fable-5-2')
    expect(steps[0]?.effort).toBe('medium')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const row = await ui.find({ type: 'Text', text: /Active/ })
      expect(row?.text).toBe('  [Frontier] Fable 5.2 Active... effort medium')
      expect(await ui.find({ type: 'Text', text: /Limit Expired/ })).toBe(undefined)
      await ui.unmount()
    }
  })

  test('FRONTIER after the deadline runs Opus and grays Fable out', async ($, on) => {
    mock.clock(on, { now: AFTER })
    const steps: TurnStepInput[] = []
    engine(on, 'FRONTIER', steps)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.prompt.submit(typed('Design a novel consensus protocol.'))
    await drain($.turn.step(step('t1')))

    expect(steps[0]?.model).toBe('claude-opus-5-5')
    expect(steps[0]?.effort).toBe('medium')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /Limit Expired/ }))?.text).toBe(' Limit Expired ')
    expect((await ui.find({ type: 'Text', text: /Active/ }))?.text).toBe(
      '  [Frontier] Opus 5.5 Active... effort medium',
    )
    await ui.unmount()
  })

  test('the deadline passing mid-session expires Fable live', async ($, on) => {
    const clock = mock.clock(on, { now: FABLE_DEADLINE_UTC_MS - 60_000 })
    const steps: TurnStepInput[] = []
    engine(on, 'FRONTIER', steps)

    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.prompt.submit(typed('Long autonomous refactor.'))
    await drain($.turn.step(step('t1', 0)))
    await clock.advance(120_000)
    await drain($.turn.step(step('t1', 1)))

    expect(steps.map(s => s.model)).toEqual(['claude-fable-5-2', 'claude-opus-5-5'])
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.find({ type: 'Text', text: /Limit Expired/ }))?.text).toBe(' Limit Expired ')
    await ui.unmount()
  })

  test('a short SIMPLE prompt runs Haiku at low effort', async ($, on) => {
    mock.clock(on, { now: BEFORE })
    const steps: TurnStepInput[] = []
    engine(on, 'SIMPLE', steps)

    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.prompt.submit(typed('rename foo to bar'))
    await drain($.turn.step(step('t1')))

    expect(steps[0]?.model).toBe('claude-haiku-5-5')
    expect(steps[0]?.effort).toBe('low')
  })

  test('an unreadable gatekeeper reply falls back to Sonnet', async ($, on) => {
    mock.clock(on, { now: BEFORE })
    const steps: TurnStepInput[] = []
    engine(on, null, steps)

    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.prompt.submit(typed('fix the flaky test in auth.spec.ts'))
    await drain($.turn.step(step('t1')))

    expect(steps[0]?.model).toBe('claude-sonnet-5-5')
  })

  test('subagent steps and turns after completion are left alone', async ($, on) => {
    mock.clock(on, { now: BEFORE })
    const steps: TurnStepInput[] = []
    engine(on, 'COMPLEX', steps)

    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.prompt.submit(typed('review the scheduler'))
    await drain($.turn.step({ ...step('t1'), agentId: 'a1' }))
    await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' })
    await drain($.turn.step(step('t2')))

    expect(steps.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
    expect(steps.map(s => s.effort)).toEqual(['high', 'high'])
  })

  test('/aegis off disables routing', async ($, on) => {
    mock.clock(on, { now: BEFORE })
    const steps: TurnStepInput[] = []
    engine(on, 'FRONTIER', steps)

    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.command.run({
      command: 'aegis',
      args: 'off',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
    await $.prompt.submit(typed('Design a novel consensus protocol.'))
    await drain($.turn.step(step('t1')))

    expect(steps[0]?.model).toBe('claude-opus-5-5')
  })
})
