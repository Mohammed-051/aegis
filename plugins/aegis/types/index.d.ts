export type Tier = 'SIMPLE' | 'STANDARD' | 'COMPLEX' | 'FRONTIER'
export type ModelId =
  | 'claude-haiku-5-5'
  | 'claude-sonnet-5-5'
  | 'claude-opus-5-5'
  | 'claude-fable-5-2'
export type Effort = 'low' | 'medium' | 'high'
export type Phase = 'idle' | 'classifying' | 'active'

export type RouteState = {
  phase: Phase
  tier?: Tier
  model?: ModelId
  effort?: Effort
  demoted: boolean
  classifierFailed: boolean
  turns: number
}

declare module 'claude-code' {
  interface PluginState {
    aegis: {
      route: Shaped<RouteState>
      frame: number
      enabled: boolean
      fableExpired: boolean
    }
  }
}
