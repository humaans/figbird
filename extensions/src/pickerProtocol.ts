export const PICKER_KEY = '__FIGBIRD_DEVTOOLS_PICKER__'
export const PICKER_PROTOCOL = 1

export type PickerWireSnapshot =
  | { kind: 'idle'; version: number }
  | { kind: 'picking'; version: number }
  | {
      kind: 'selected'
      label: string
      queryCounts: Record<string, number>
      supported: boolean
      truncated: boolean
      version: number
    }
