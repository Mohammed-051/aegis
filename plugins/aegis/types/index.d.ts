export type Tier = 'SIMPLE' | 'STANDARD' | 'COMPLEX' | 'FRONTIER'
export type ModelId =
  | 'claude-haiku-5-5'
  | 'claude-sonnet-5-5'
  | 'claude-opus-5-5'
  | 'claude-fable-5-2'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh'
export type Phase = 'idle' | 'routing' | 'active'
export type RouterChoice = 'opus' | 'fable'
export type RouteSource = 'router' | 'sticky' | 'fallback'

export type RouteState = {
  phase: Phase
  tier?: Tier
  model?: ModelId
  effort?: Effort
  reason?: string
  source?: RouteSource
  routerModel?: ModelId
  demoted: boolean
  turns: number
  routerCalls: number
  routerTokens: number
  lastRouterMs?: number
}

declare module 'claude-code' {
  interface PluginState {
    aegis: {
      route: Shaped<RouteState>
      frame: number
      enabled: boolean
      fableExpired: boolean
      router: RouterChoice | 'default'
    }
  }
}
